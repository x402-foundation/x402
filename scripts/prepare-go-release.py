#!/usr/bin/env python3
"""Prepare a Go SDK release by bumping the version and building the changelog.

Run from the repository root:

    python3 scripts/prepare-go-release.py --version 2.15.0
    python3 scripts/prepare-go-release.py --bump minor
    python3 scripts/prepare-go-release.py --bump patch --dry-run

Either ``--version X.Y.Z`` or ``--bump {minor,patch}`` is required. Major version
bumps are rejected. Use ``--dry-run`` to validate without writing files.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
CONSTANTS_VERSION_RE = re.compile(r'^(\s*)Version = "([^"]+)"$', re.MULTILINE)
KIND_RE = re.compile(r"^kind:\s*(\S+)\s*$", re.MULTILINE)
BODY_RE = re.compile(r"^body:\s*(.+?)(?:\ntime:|\Z)", re.MULTILINE | re.DOTALL)
TIME_RE = re.compile(r"^time:\s*(.+)\s*$", re.MULTILINE)
DEFAULT_REPOSITORY = "x402-foundation/x402"
REPOSITORY_URL = f"https://github.com/{DEFAULT_REPOSITORY}"

PR_COMMIT_AUTHORS_QUERY = """
query($owner: String!, $name: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      author {
        login
      }
      commits(first: 100, after: $after) {
        pageInfo {
          hasNextPage
          endCursor
        }
        nodes {
          commit {
            authors(first: 100) {
              nodes {
                user {
                  login
                }
              }
            }
          }
        }
      }
    }
  }
}
"""


class ReleasePrepError(RuntimeError):
    """Raised when the release-prep inputs or files are invalid."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Prepare the Go SDK release version and Changie changelog."
    )
    version_group = parser.add_mutually_exclusive_group(required=True)
    version_group.add_argument(
        "--version",
        help="Explicit release version, in X.Y.Z format (optional v prefix is stripped).",
    )
    version_group.add_argument(
        "--bump",
        choices=["minor", "patch"],
        help="Bump the current version. Scheduled releases use 'minor'.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and print the target version without modifying files.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def sdk_dir() -> Path:
    return repo_root() / "go"


def require_file(path: Path) -> None:
    if not path.is_file():
        raise ReleasePrepError(f"Required file does not exist: {path}")


def require_directory(path: Path) -> None:
    if not path.is_dir():
        raise ReleasePrepError(f"Required directory does not exist: {path}")


def changelog_fragments(unreleased_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in unreleased_dir.iterdir()
        if path.is_file()
        and path.suffix in {".yaml", ".yml"}
        and not path.name.startswith(".")
    )


def normalize_version(version: str) -> str:
    return version.removeprefix("v")


def validate_version(version: str) -> tuple[int, int, int]:
    normalized = normalize_version(version)
    match = VERSION_RE.fullmatch(normalized)
    if match is None:
        raise ReleasePrepError(f"Expected version in X.Y.Z format, got: {version}")
    return tuple(int(part) for part in match.groups())


def changie_version(version: str) -> str:
    normalized = normalize_version(version)
    validate_version(normalized)
    return f"v{normalized}"


def extract_constants_version(path: Path) -> str:
    content = path.read_text()
    matches = CONSTANTS_VERSION_RE.findall(content)
    if len(matches) != 1:
        raise ReleasePrepError(
            f"Expected exactly one Version constant in {path}, found {len(matches)}"
        )
    return normalize_version(matches[0][1])


def bump_version(version: str, bump: str) -> str:
    major, minor, patch = validate_version(version)
    if bump == "minor":
        return f"{major}.{minor + 1}.0"
    if bump == "patch":
        return f"{major}.{minor}.{patch + 1}"
    raise ReleasePrepError(f"Unsupported bump type: {bump}")


def assert_version_increases(current_version: str, target_version: str) -> None:
    if validate_version(target_version) <= validate_version(current_version):
        raise ReleasePrepError(
            f"Target version {target_version} must be greater than current version {current_version}"
        )


def assert_no_major_bump(current_version: str, target_version: str) -> None:
    current_major = validate_version(current_version)[0]
    target_major = validate_version(target_version)[0]
    if target_major > current_major:
        raise ReleasePrepError(
            f"Major version bumps are not allowed: {current_version} -> {target_version}"
        )


def replace_constants_version(path: Path, target_version: str) -> None:
    content = path.read_text()
    updated, count = CONSTANTS_VERSION_RE.subn(
        rf'\1Version = "{normalize_version(target_version)}"',
        content,
    )
    if count != 1:
        raise ReleasePrepError(
            f"Expected to update exactly one Version constant in {path}, updated {count}"
        )
    path.write_text(updated)


def git_output(root: Path, command: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["git", *command],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    return completed.stdout.strip()


def gh_output(root: Path, command: list[str]) -> str | None:
    try:
        completed = subprocess.run(
            ["gh", *command],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError):
        return None

    return completed.stdout.strip()


def repository_name() -> str:
    repository = os.environ.get("GITHUB_REPOSITORY", DEFAULT_REPOSITORY)
    if "/" not in repository:
        return DEFAULT_REPOSITORY

    return repository


def fragment_commit_sha(root: Path, fragment: Path) -> str | None:
    relative_fragment = fragment.relative_to(root)
    # Prefer the commit that added the fragment. Later release-prep edits must
    # not override attribution for the original contributing PR.
    output = git_output(
        root,
        ["log", "--diff-filter=A", "-1", "--format=%H", "--", str(relative_fragment)],
    )
    if not output:
        output = git_output(
            root,
            ["log", "-1", "--format=%H", "--", str(relative_fragment)],
        )
    if not output:
        return None

    return output


def add_unique(items: list[str], item: str | None) -> None:
    if item is not None and item not in items:
        items.append(item)


def pr_authors(root: Path, issue: str) -> tuple[str | None, list[str]]:
    owner, name = repository_name().split("/", 1)
    pr_author: str | None = None
    commit_authors: list[str] = []
    cursor = None

    while True:
        command = [
            "api",
            "graphql",
            "-f",
            f"query={PR_COMMIT_AUTHORS_QUERY}",
            "-F",
            f"owner={owner}",
            "-F",
            f"name={name}",
            "-F",
            f"number={issue}",
        ]
        if cursor is not None:
            command.extend(["-f", f"after={cursor}"])

        output = gh_output(root, command)
        if not output:
            break

        try:
            data = json.loads(output)
            pull_request = data["data"]["repository"]["pullRequest"]
            commits = pull_request["commits"]
        except (KeyError, TypeError, json.JSONDecodeError):
            break

        if (author := pull_request.get("author")) is not None:
            pr_author = author.get("login")

        for node in commits["nodes"]:
            for commit_author in node["commit"]["authors"]["nodes"]:
                user = commit_author.get("user")
                if user is not None:
                    add_unique(commit_authors, user.get("login"))

        if not commits["pageInfo"]["hasNextPage"]:
            break

        cursor = commits["pageInfo"]["endCursor"]

    if pr_author is None and commit_authors:
        pr_author = commit_authors[0]

    contributors = [login for login in commit_authors if login != pr_author]
    return pr_author, contributors


def author_link(login: str) -> str:
    return f"[@{login}](https://github.com/{login})"


def thanks_text(pr_author: str | None, contributors: list[str]) -> str | None:
    if pr_author is None:
        return None

    text = author_link(pr_author)
    if contributors:
        text += " and " + ", ".join(author_link(login) for login in contributors)

    return f"Thanks {text}!"


def commit_author_login(root: Path, commit_sha: str) -> str | None:
    output = gh_output(
        root,
        ["api", f"repos/{repository_name()}/commits/{commit_sha}", "--jq", ".author.login"],
    )
    if not output or output == "null":
        return None

    return output


def commit_pr_number(root: Path, commit_sha: str) -> str | None:
    output = gh_output(
        root,
        ["api", f"repos/{repository_name()}/commits/{commit_sha}/pulls", "--jq", ".[0].number"],
    )
    if not output or output == "null":
        return None

    return output


def fragment_thanks(root: Path, pr_number: str | None, commit_sha: str | None) -> str | None:
    pr_author: str | None = None
    contributors: list[str] = []

    if pr_number is not None:
        pr_author, contributors = pr_authors(root, pr_number)

    if pr_author is None and commit_sha is not None:
        pr_author = commit_author_login(root, commit_sha)

    return thanks_text(pr_author, contributors)


def changie_kind_keys(root: Path) -> dict[str, str]:
    """Map kind label or alias (case-insensitive) to the changie kind key."""
    config_path = root / ".changie.yaml"
    if not config_path.is_file():
        raise ReleasePrepError(f"Required file does not exist: {config_path}")

    aliases: dict[str, str] = {}
    label: str | None = None
    in_kinds = False
    for line in config_path.read_text().splitlines():
        if line.startswith("kinds:"):
            in_kinds = True
            continue
        if not in_kinds:
            continue
        if line and not line[0].isspace():
            break
        if match := re.match(r"^\s+-\s+label:\s*(.+?)\s*$", line):
            label = match.group(1).strip()
            aliases.setdefault(label.lower(), label.lower())
        elif label is not None and (
            match := re.match(r"^\s+key:\s*(.+?)\s*$", line)
        ):
            key = match.group(1).strip()
            aliases[label.lower()] = key
            aliases[key.lower()] = key
            label = None

    if not aliases:
        raise ReleasePrepError(f"No kinds configured in {config_path}")

    return aliases


def normalize_changie_kind(root: Path, kind: str) -> str:
    aliases = changie_kind_keys(root)
    normalized = aliases.get(kind.lower())
    if normalized is None:
        known = ", ".join(sorted({value for value in aliases.values()}))
        raise ReleasePrepError(
            f"Unknown changelog kind '{kind}'. Expected one of: {known}"
        )
    return normalized


def read_changie_fragment(fragment: Path) -> tuple[str, str, str | None]:
    content = fragment.read_text()
    kind_match = KIND_RE.search(content)
    body_match = BODY_RE.search(content)
    if kind_match is None or body_match is None:
        raise ReleasePrepError(f"Could not parse Changie fragment: {fragment}")

    time_match = TIME_RE.search(content)
    time = time_match.group(1).strip() if time_match is not None else None
    return kind_match.group(1), body_match.group(1).strip(), time


def write_changie_fragment(
    fragment: Path, kind: str, body: str, time: str | None = None
) -> None:
    lines = [f"kind: {kind}", f"body: {json.dumps(body)}"]
    if time is not None:
        lines.append(f"time: {time}")
    fragment.write_text("\n".join(lines) + "\n")


def fragment_changelog_body(root: Path, fragment: Path, body: str) -> str | None:
    text = " ".join(body.split())
    if not text:
        return None

    commit_sha = fragment_commit_sha(root, fragment)
    pr_number = commit_pr_number(root, commit_sha) if commit_sha is not None else None

    rendered = text
    if pr_number is not None:
        rendered += f" ([#{pr_number}]({REPOSITORY_URL}/pull/{pr_number}))"

    if (thanks := fragment_thanks(root, pr_number, commit_sha)) is not None:
        rendered += f" - {thanks}"

    return rendered


def changelog_fragment_bodies(
    root: Path, fragments: list[Path]
) -> list[tuple[Path, str, str, str | None]]:
    bodies: list[tuple[Path, str, str, str | None]] = []
    for fragment in fragments:
        kind, body, time = read_changie_fragment(fragment)
        kind = normalize_changie_kind(root, kind)
        rendered = fragment_changelog_body(root, fragment, body)
        if rendered is not None:
            bodies.append((fragment, kind, rendered, time))
    return bodies


def print_changelog_fragment_preview(
    bodies: list[tuple[Path, str, str, str | None]],
) -> None:
    if not bodies:
        return

    print("Changelog fragment preview:")
    for _, _, body, _ in bodies:
        print(f"- {body}")
    print()


def rewrite_fragments(
    root: Path, bodies: list[tuple[Path, str, str, str | None]]
) -> None:
    for fragment, kind, body, time in bodies:
        write_changie_fragment(fragment, kind, body, time)
        git_output(root, ["add", "--", str(fragment.relative_to(root))])


def go_gopath() -> str:
    try:
        completed = subprocess.run(
            ["go", "env", "GOPATH"],
            check=True,
            capture_output=True,
            text=True,
        )
    except (FileNotFoundError, subprocess.CalledProcessError) as exc:
        raise ReleasePrepError(
            "go is required to locate changie. Install Go and run: cd go && make deps-dev"
        ) from exc

    return completed.stdout.strip()


def changie_binary() -> Path:
    gopath = go_gopath()

    candidates = [Path(gopath) / "bin" / "changie"]
    path_changie = shutil.which("changie")
    if path_changie is not None:
        candidates.insert(0, Path(path_changie))

    for candidate in candidates:
        if candidate.is_file():
            return candidate

    raise ReleasePrepError(
        "changie is required to build the changelog. Install it with: cd go && make deps-dev"
    )


def run_changie(root: Path, *args: str) -> None:
    changie = changie_binary()
    try:
        subprocess.run([str(changie), *args], cwd=root, check=True)
    except subprocess.CalledProcessError as exc:
        raise ReleasePrepError(f"changie failed with exit code {exc.returncode}.") from exc


def main() -> int:
    args = parse_args()
    root = sdk_dir()
    constants_file = root / "constants.go"
    unreleased_dir = root / ".changes" / "unreleased"
    changes_dir = root / ".changes"

    require_file(constants_file)
    require_directory(unreleased_dir)

    fragments = changelog_fragments(unreleased_dir)
    if not fragments:
        print("No changelog fragments found; release preparation skipped.")
        return 0

    current_version = extract_constants_version(constants_file)
    target_version = (
        normalize_version(args.version)
        if args.version is not None
        else bump_version(current_version, args.bump)
    )
    validate_version(target_version)
    assert_version_increases(current_version, target_version)
    assert_no_major_bump(current_version, target_version)

    version_tag = changie_version(target_version)
    version_file = changes_dir / f"{version_tag}.md"
    if version_file.exists():
        raise ReleasePrepError(f"Version file already exists: {version_file}")

    fragment_bodies = changelog_fragment_bodies(root, fragments)
    print_changelog_fragment_preview(fragment_bodies)

    if args.dry_run:
        print(f"Current Go SDK version: {current_version}")
        print(f"Target Go SDK version: {target_version}")
        print(f"Changie version tag: {version_tag}")
        print("Dry run complete; no files were changed.")
        return 0

    rewrite_fragments(root, fragment_bodies)
    run_changie(root, "batch", version_tag)
    git_output(root, ["add", "--", str(version_file.relative_to(root))])
    run_changie(root, "merge")
    replace_constants_version(constants_file, target_version)

    print(f"Prepared Go SDK release {target_version}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleasePrepError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
