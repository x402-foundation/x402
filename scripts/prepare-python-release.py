#!/usr/bin/env python3
"""Prepare a Python SDK release by bumping versions and building the changelog.

Run from the repository root:

    python3 scripts/prepare-python-release.py --version 1.2.3
    python3 scripts/prepare-python-release.py --bump minor
    python3 scripts/prepare-python-release.py --bump patch --dry-run

Either ``--version X.Y.Z`` or ``--bump {minor,patch}`` is required. Major version
bumps are rejected. Use ``--dry-run`` to validate without writing files.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from pathlib import Path

VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
PYPROJECT_VERSION_RE = re.compile(r'^version = "([^"]+)"$', re.MULTILINE)
INIT_VERSION_RE = re.compile(r'^__version__ = "([^"]+)"$', re.MULTILINE)
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
        description="Prepare the Python SDK release version and Towncrier changelog."
    )
    version_group = parser.add_mutually_exclusive_group(required=True)
    version_group.add_argument("--version", help="Explicit release version, in X.Y.Z format.")
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


def package_dir() -> Path:
    return repo_root() / "python" / "x402"


def require_file(path: Path) -> None:
    if not path.is_file():
        raise ReleasePrepError(f"Required file does not exist: {path}")


def require_directory(path: Path) -> None:
    if not path.is_dir():
        raise ReleasePrepError(f"Required directory does not exist: {path}")


def changelog_fragments(changelog_dir: Path) -> list[Path]:
    return sorted(
        path for path in changelog_dir.iterdir() if path.is_file() and not path.name.startswith(".")
    )


def validate_version(version: str) -> tuple[int, int, int]:
    match = VERSION_RE.fullmatch(version)
    if match is None:
        raise ReleasePrepError(f"Expected version in X.Y.Z format, got: {version}")
    return tuple(int(part) for part in match.groups())


def extract_single_version(path: Path, pattern: re.Pattern[str], label: str) -> str:
    content = path.read_text()
    matches = pattern.findall(content)
    if len(matches) != 1:
        raise ReleasePrepError(
            f"Expected exactly one {label} version in {path}, found {len(matches)}"
        )
    validate_version(matches[0])
    return matches[0]


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


def replace_single(path: Path, pattern: re.Pattern[str], replacement: str, label: str) -> None:
    content = path.read_text()
    updated, count = pattern.subn(replacement, content)
    if count != 1:
        raise ReleasePrepError(
            f"Expected to update exactly one {label} version in {path}, updated {count}"
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


def fragment_text(fragment: Path) -> str:
    return " ".join(fragment.read_text().split())


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
    """Return ``(pr_author, contributors)`` for a pull request.

    ``pr_author`` is the login of the user who opened the PR. ``contributors`` are
    the distinct commit-author logins on the PR, with ``pr_author`` removed so it
    is never listed twice."""
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


def fragment_changelog_body(root: Path, fragment: Path) -> str | None:
    text = fragment_text(fragment)
    if not text:
        return None

    commit_sha = fragment_commit_sha(root, fragment)
    pr_number = commit_pr_number(root, commit_sha) if commit_sha is not None else None

    body = text
    if pr_number is not None:
        body += f" ([#{pr_number}]({REPOSITORY_URL}/pull/{pr_number}))"

    if (thanks := fragment_thanks(root, pr_number, commit_sha)) is not None:
        body += f" - {thanks}"

    return body


def changelog_fragment_bodies(root: Path, fragments: list[Path]) -> list[tuple[Path, str]]:
    return [
        (fragment, body)
        for fragment in fragments
        if (body := fragment_changelog_body(root, fragment)) is not None
    ]


def print_changelog_fragment_preview(bodies: list[tuple[Path, str]]) -> None:
    if not bodies:
        return

    print("Changelog fragment preview:")
    for _, body in bodies:
        print(f"- {body}")
    print()


def rewrite_fragments_as_orphans(root: Path, bodies: list[tuple[Path, str]]) -> None:
    """Replace each fragment with an orphan fragment whose body is the rendered
    changelog line. Towncrier renders orphan fragments (filenames prefixed with
    ``+``) verbatim without appending its own issue link, so the PR link, commit
    hash, and author attribution from the preview land in CHANGELOG.md.

    The orphan files are staged so Towncrier's git-based cleanup can remove them;
    otherwise it invokes ``git rm`` with no paths and prints a spurious error."""
    for fragment, body in bodies:
        orphan = fragment.with_name(f"+{fragment.name}")
        orphan.write_text(f"{body}\n")
        fragment.unlink()
        git_output(root, ["add", "--", str(orphan.relative_to(root))])


def run_towncrier(sdk_dir: Path, version: str) -> None:
    try:
        subprocess.run(
            ["uv", "run", "towncrier", "build", "--yes", f"--version={version}"],
            cwd=sdk_dir,
            check=True,
        )
    except FileNotFoundError as exc:
        raise ReleasePrepError("uv is required to build the Towncrier changelog.") from exc
    except subprocess.CalledProcessError as exc:
        raise ReleasePrepError(f"Towncrier failed with exit code {exc.returncode}.") from exc


def main() -> int:
    args = parse_args()
    sdk_dir = package_dir()
    pyproject = sdk_dir / "pyproject.toml"
    init_file = sdk_dir / "__init__.py"
    changelog_dir = sdk_dir / "changelog.d"

    require_file(pyproject)
    require_file(init_file)
    require_directory(changelog_dir)

    fragments = changelog_fragments(changelog_dir)
    if not fragments:
        print("No changelog fragments found; release preparation skipped.")
        return 0

    current_version = extract_single_version(pyproject, PYPROJECT_VERSION_RE, "pyproject.toml")
    init_version = extract_single_version(init_file, INIT_VERSION_RE, "__init__.py")
    if init_version != current_version:
        raise ReleasePrepError(
            f"Version mismatch: pyproject.toml has {current_version}, __init__.py has {init_version}"
        )

    target_version = (
        args.version if args.version is not None else bump_version(current_version, args.bump)
    )
    validate_version(target_version)
    assert_version_increases(current_version, target_version)
    assert_no_major_bump(current_version, target_version)

    fragment_bodies = changelog_fragment_bodies(sdk_dir, fragments)
    print_changelog_fragment_preview(fragment_bodies)

    if args.dry_run:
        print(f"Current Python SDK version: {current_version}")
        print(f"Target Python SDK version: {target_version}")
        print("Dry run complete; no files were changed.")
        return 0

    replace_single(
        pyproject,
        PYPROJECT_VERSION_RE,
        f'version = "{target_version}"',
        "pyproject.toml",
    )
    replace_single(
        init_file,
        INIT_VERSION_RE,
        f'__version__ = "{target_version}"',
        "__init__.py",
    )
    rewrite_fragments_as_orphans(sdk_dir, fragment_bodies)
    run_towncrier(sdk_dir, target_version)

    print(f"Prepared Python SDK release {target_version}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleasePrepError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
