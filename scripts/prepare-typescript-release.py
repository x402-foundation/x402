#!/usr/bin/env python3
"""Prepare a TypeScript SDK release by consuming pending changesets.

Run from the repository root:

    python3 scripts/prepare-typescript-release.py
    python3 scripts/prepare-typescript-release.py --dry-run
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager, nullcontext
from pathlib import Path

DEFAULT_REPOSITORY = "x402-foundation/x402"
REPOSITORY_URL = f"https://github.com/{DEFAULT_REPOSITORY}"
FRONTMATTER_RE = re.compile(r"^---\s*\n(.*?)\n---\s*\n", re.DOTALL)
MAJOR_BUMP_LINE_RE = re.compile(r"^(\s*['\"]?[^'\":\n]+['\"]?\s*:\s*)major\s*$")
PACKAGE_BUMP_LINE_RE = re.compile(
    r"^\s*['\"]?([^'\":\n]+)['\"]?\s*:\s*(?:major|minor|patch)\s*$"
)
EMPTY_CORE_CHANGELOG_SECTION_RE = re.compile(
    r"^(# @x402/core Changelog\n\n)(## \d+\.\d+\.\d+\n)(\n)(## )",
    re.MULTILINE,
)
CORE_CHANGELOG_ALIGNMENT_ENTRY = (
    "\n### Minor Changes\n\n"
    "- Bumped to align version with dependent packages\n"
)
VERSION_SECTION_RE = re.compile(
    r"^(?P<header>#[^\n]+\n\n)(?P<section>## \d+\.\d+\.\d+\n.*?)(?=\n## |\Z)",
    re.DOTALL,
)
MINOR_CHANGES_HEADING = "### Minor Changes"
PATCH_CHANGES_HEADING = "### Patch Changes"
STANDALONE_DEP_LINE_RE = re.compile(r"^- @x402/[\w-]+@\d+\.\d+\.\d+$")
UPDATED_DEPS_LINE_RE = re.compile(
    r"^- Updated dependencies(?: \[[a-f0-9]+\](?:\([^)]+\))?)?$"
)
INDENTED_DEP_LINE_RE = re.compile(r"^  - @x402/[\w-]+@\d+\.\d+\.\d+$")
COMMIT_ENTRY_PREFIX_RE = re.compile(r"^(- )([a-f0-9]{7,40})(: )", re.MULTILINE)
UPDATED_DEPS_SHA_RE = re.compile(
    r"(Updated dependencies )\[([a-f0-9]{7,40})\](?!\()"
)

PUBLISH_WORKFLOWS = [
    ("@x402/core", "Publish @x402/core package to NPM"),
    ("@x402/extensions", "Publish @x402/extensions package to NPM"),
    (
        "mechanisms",
        [
            ("@x402/evm", "Publish @x402/evm package to NPM"),
            ("@x402/svm", "Publish @x402/svm package to NPM"),
            ("@x402/avm", "Publish @x402/avm package to NPM"),
            ("@x402/aptos", "Publish @x402/aptos package to NPM"),
            ("@x402/stellar", "Publish @x402/stellar package to NPM"),
            ("@x402/hedera", "Publish @x402/hedera package to NPM"),
            ("@x402/tvm", "Publish @x402/tvm package to NPM"),
            ("@x402/keeta", "Publish @x402/keeta package to NPM"),
            ("@x402/near", "Publish @x402/near package to NPM"),
            ("@x402/concordium", "Publish @x402/concordium package to NPM"),
            ("@x402/xrpl", "Publish @x402/xrpl package to NPM"),
        ],
    ),
    ("@x402/paywall", "Publish @x402/paywall package to NPM"),
    (
        "http + mcp",
        [
            ("@x402/axios", "Publish @x402/axios package to NPM"),
            ("@x402/fetch", "Publish @x402/fetch package to NPM"),
            ("@x402/express", "Publish @x402/express package to NPM"),
            ("@x402/hono", "Publish @x402/hono package to NPM"),
            ("@x402/next", "Publish @x402/next package to NPM"),
            ("@x402/fastify", "Publish @x402/fastify package to NPM"),
            ("@x402/mcp", "Publish @x402/mcp package to NPM"),
        ],
    ),
]

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
        description="Prepare the TypeScript SDK release by consuming pending changesets."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Validate inputs and preview changelog entries and version bumps without modifying files.",
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def sdk_dir() -> Path:
    return repo_root() / "typescript"


def require_directory(path: Path) -> None:
    if not path.is_dir():
        raise ReleasePrepError(f"Required directory does not exist: {path}")


def changeset_files(changeset_dir: Path) -> list[Path]:
    return sorted(
        path
        for path in changeset_dir.iterdir()
        if path.is_file() and path.suffix == ".md" and path.name != "README.md"
    )


def read_changeset(path: Path) -> tuple[str, str]:
    content = path.read_text()
    match = FRONTMATTER_RE.match(content)
    if match is None:
        raise ReleasePrepError(f"Could not parse changeset frontmatter: {path}")

    return match.group(1), content[match.end() :].strip()


def write_changeset(path: Path, frontmatter: str, body: str) -> None:
    path.write_text(f"---\n{frontmatter}\n---\n\n{body}\n")


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
    # Prefer the commit that added the fragment. Later release-prep edits to a
    # changeset must not override attribution for the original contributing PR.
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


def commit_url(sha: str) -> str:
    return f"https://github.com/{repository_name()}/commit/{sha}"


def commit_sha_link(sha: str) -> str:
    return f"[{sha}]({commit_url(sha)})"


def link_commit_shas_in_text(text: str) -> str:
    text = COMMIT_ENTRY_PREFIX_RE.sub(
        lambda match: f"{match.group(1)}{commit_sha_link(match.group(2))}{match.group(3)}",
        text,
    )
    return UPDATED_DEPS_SHA_RE.sub(
        lambda match: f"{match.group(1)}{commit_sha_link(match.group(2))}",
        text,
    )


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


def changeset_changelog_body(root: Path, changeset: Path, body: str) -> str | None:
    text = " ".join(body.split())
    if not text:
        return None

    commit_sha = fragment_commit_sha(root, changeset)
    pr_number = commit_pr_number(root, commit_sha) if commit_sha is not None else None

    rendered = text
    if pr_number is not None:
        rendered += f" ([#{pr_number}]({REPOSITORY_URL}/pull/{pr_number}))"

    if (thanks := fragment_thanks(root, pr_number, commit_sha)) is not None:
        rendered += f" - {thanks}"

    return rendered


def changeset_bodies(root: Path, changesets: list[Path]) -> list[tuple[Path, str, str]]:
    bodies: list[tuple[Path, str, str]] = []
    for changeset in changesets:
        frontmatter, body = read_changeset(changeset)
        rendered = changeset_changelog_body(root, changeset, body)
        if rendered is not None:
            bodies.append((changeset, frontmatter, rendered))
    return bodies


def print_changeset_preview(bodies: list[tuple[Path, str, str]]) -> None:
    if not bodies:
        return

    print("Changeset preview:")
    for changeset, _, body in bodies:
        print(f"- {changeset.name}: {body}")
    print()


def rewrite_changesets(root: Path, bodies: list[tuple[Path, str, str]]) -> None:
    for changeset, frontmatter, body in bodies:
        write_changeset(changeset, frontmatter, body)
        git_output(root, ["add", "--", str(changeset.relative_to(root))])


def downgrade_major_bumps_in_frontmatter(frontmatter: str) -> tuple[str, list[str]]:
    downgraded_lines: list[str] = []
    new_lines: list[str] = []

    for line in frontmatter.splitlines():
        match = MAJOR_BUMP_LINE_RE.match(line)
        if match is None:
            new_lines.append(line)
            continue

        downgraded_lines.append(line.strip())
        new_lines.append(f"{match.group(1)}minor")

    return "\n".join(new_lines), downgraded_lines


def sanitize_major_version_bumps(
    root: Path, changesets: list[Path], *, dry_run: bool
) -> None:
    for changeset in changesets:
        frontmatter, body = read_changeset(changeset)
        new_frontmatter, downgraded_lines = downgrade_major_bumps_in_frontmatter(frontmatter)
        if not downgraded_lines:
            continue

        print(
            f"warning: Downgraded major version bump(s) to minor in {changeset.name}: "
            + ", ".join(downgraded_lines)
        )
        if dry_run:
            continue

        write_changeset(changeset, new_frontmatter, body)
        git_output(root, ["add", "--", str(changeset.relative_to(root))])


def publishable_package_jsons(root: Path) -> list[Path]:
    packages_dir = root / "packages"
    return sorted(
        path
        for path in packages_dir.rglob("package.json")
        if "legacy" not in path.parts
    )


def publishable_package_names(root: Path) -> set[str]:
    names: set[str] = set()

    for package_json in publishable_package_jsons(root):
        try:
            data = json.loads(package_json.read_text())
            names.add(data.get("name", str(package_json.parent)))
        except (TypeError, json.JSONDecodeError):
            continue

    return names


def print_core_version_deviation_warnings(
    mismatches: list[tuple[str, str]], core_version: str, *, label: str
) -> None:
    if not mismatches:
        return

    print(f"warning: [{label}] Package version(s) deviate from @x402/core ({core_version}):")
    for name, version in mismatches:
        print(f"  - {name}: {version}")


def warn_if_package_versions_deviate_from_core(root: Path, *, label: str) -> None:
    core_package_json = root / "packages" / "core" / "package.json"
    core_version = read_core_version(root)
    mismatches: list[tuple[str, str]] = []

    for package_json in publishable_package_jsons(root):
        if package_json == core_package_json:
            continue

        try:
            data = json.loads(package_json.read_text())
            name = data.get("name", str(package_json.parent))
            version = data["version"]
        except (KeyError, TypeError, json.JSONDecodeError):
            continue

        if version != core_version:
            mismatches.append((name, version))

    print_core_version_deviation_warnings(mismatches, core_version, label=label)


def warn_if_release_versions_deviate_from_core(
    releases: list[dict], root: Path, *, label: str
) -> None:
    publishable_names = publishable_package_names(root)
    core_release = next(
        (release for release in releases if release.get("name") == "@x402/core"),
        None,
    )
    if core_release is None:
        return

    core_version = core_release.get("newVersion")
    if core_version is None:
        return

    mismatches: list[tuple[str, str]] = []
    for release in releases:
        name = release.get("name")
        if name is None or name == "@x402/core" or name not in publishable_names:
            continue

        version = release.get("newVersion")
        if version is None or version == core_version:
            continue

        mismatches.append((name, version))

    print_core_version_deviation_warnings(mismatches, core_version, label=label)


def changesets_have_major_bumps(changesets: list[Path]) -> bool:
    for changeset in changesets:
        frontmatter, _ = read_changeset(changeset)
        _, downgraded_lines = downgrade_major_bumps_in_frontmatter(frontmatter)
        if downgraded_lines:
            return True

    return False


@contextmanager
def temporarily_sanitized_major_bumps(root: Path, changesets: list[Path]):
    backups: dict[Path, str] = {}

    try:
        for changeset in changesets:
            frontmatter, body = read_changeset(changeset)
            new_frontmatter, downgraded_lines = downgrade_major_bumps_in_frontmatter(frontmatter)
            if not downgraded_lines:
                continue

            backups[changeset] = changeset.read_text()
            write_changeset(changeset, new_frontmatter, body)

        yield
    finally:
        for path, content in backups.items():
            path.write_text(content)


def run_changeset_status(root: Path) -> dict:
    output_path = root / ".changeset-status-preview.json"

    try:
        subprocess.run(
            ["pnpm", "exec", "changeset", "status", f"--output={output_path.name}"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
        )
    except FileNotFoundError as exc:
        raise ReleasePrepError(
            "pnpm is required to preview version bumps. Install pnpm and run: cd typescript && pnpm install"
        ) from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        detail = f": {stderr}" if stderr else ""
        raise ReleasePrepError(
            f"pnpm changeset status failed with exit code {exc.returncode}{detail}."
        ) from exc

    try:
        return json.loads(output_path.read_text())
    except json.JSONDecodeError as exc:
        raise ReleasePrepError(f"Could not parse changeset status output: {output_path}") from exc
    finally:
        output_path.unlink(missing_ok=True)


def print_version_bump_preview(releases: list[dict]) -> None:
    bumps = [
        release
        for release in releases
        if release.get("oldVersion") != release.get("newVersion")
    ]
    if not bumps:
        print("Version bump preview: no package versions would change.")
        print()
        return

    print("Version bump preview:")
    for release in sorted(bumps, key=lambda item: item["name"]):
        print(
            f"- {release['name']}: {release['oldVersion']} -> {release['newVersion']} "
            f"({release['type']})"
        )
    print()


def changeset_packages(frontmatter: str) -> set[str]:
    packages: set[str] = set()
    for line in frontmatter.splitlines():
        match = PACKAGE_BUMP_LINE_RE.match(line)
        if match is not None:
            packages.add(match.group(1).strip())
    return packages


def changesets_include_core(changesets: list[Path]) -> bool:
    for changeset in changesets:
        frontmatter, _ = read_changeset(changeset)
        if "@x402/core" in changeset_packages(frontmatter):
            return True
    return False


def core_would_get_alignment_entry(changesets: list[Path], releases: list[dict]) -> bool:
    if changesets_include_core(changesets):
        return False

    core_release = next(
        (release for release in releases if release.get("name") == "@x402/core"),
        None,
    )
    if core_release is None:
        return False

    return core_release.get("oldVersion") != core_release.get("newVersion")


def split_changelog_subsection(section: str, heading: str) -> tuple[str | None, str | None]:
    marker = f"\n{heading}\n\n"
    start = section.find(marker)
    if start == -1:
        return None, section

    content_start = start + len(marker)
    next_heading = re.search(r"\n### ", section[content_start:])
    if next_heading is None:
        body = section[content_start:].rstrip("\n")
        remainder = section[:start]
        return body, remainder

    content_end = content_start + next_heading.start()
    body = section[content_start:content_end].rstrip("\n")
    remainder = section[:start] + section[content_end:]
    return body, remainder


def changelog_entry_blocks(body: str) -> list[list[str]]:
    if not body.strip():
        return []

    blocks: list[list[str]] = []
    current: list[str] = []

    for line in body.splitlines():
        if line.startswith("- ") and current:
            blocks.append(current)
            current = [line]
            continue

        current.append(line)

    if current:
        blocks.append(current)

    return blocks


def is_dependency_changelog_block(block: list[str]) -> bool:
    if not block:
        return False

    first_line = block[0]
    if STANDALONE_DEP_LINE_RE.match(first_line):
        return True

    if UPDATED_DEPS_LINE_RE.match(first_line):
        return all(
            UPDATED_DEPS_LINE_RE.match(line)
            or INDENTED_DEP_LINE_RE.match(line)
            or not line.strip()
            for line in block
        )

    return False


def format_dependency_block(block: list[str]) -> list[str]:
    if block and STANDALONE_DEP_LINE_RE.match(block[0]):
        return ["- Updated dependencies", f"  {block[0]}"]
    return block


def join_changelog_subsection(heading: str, body: str) -> str:
    if not body.strip():
        return ""

    return f"\n{heading}\n\n{body.rstrip()}\n"


def fix_dependency_minor_changelog_section(section: str) -> tuple[str, bool]:
    minor_body, without_minor = split_changelog_subsection(section, MINOR_CHANGES_HEADING)
    patch_body, without_patch = split_changelog_subsection(without_minor, PATCH_CHANGES_HEADING)
    if patch_body is None:
        return section, False

    dependency_blocks = [
        block
        for block in changelog_entry_blocks(patch_body)
        if is_dependency_changelog_block(block)
    ]
    if not dependency_blocks:
        return section, False

    non_dependency_blocks = [
        block
        for block in changelog_entry_blocks(patch_body)
        if not is_dependency_changelog_block(block)
    ]
    formatted_dependency_blocks = [
        format_dependency_block(block) for block in dependency_blocks
    ]
    dependency_lines = [
        line
        for block in formatted_dependency_blocks
        for line in block
    ]
    new_minor_lines: list[str] = []

    if minor_body is not None and minor_body.strip():
        new_minor_lines.extend(minor_body.splitlines())

    new_minor_lines.extend(dependency_lines)
    new_minor_body = "\n".join(new_minor_lines)

    if non_dependency_blocks:
        new_patch_lines = [line for block in non_dependency_blocks for line in block]
        new_patch_body = "\n".join(new_patch_lines)
        rebuilt = (
            without_patch
            + join_changelog_subsection(MINOR_CHANGES_HEADING, new_minor_body)
            + join_changelog_subsection(PATCH_CHANGES_HEADING, new_patch_body)
        )
        return rebuilt.rstrip() + "\n", True

    rebuilt = without_patch + join_changelog_subsection(MINOR_CHANGES_HEADING, new_minor_body)
    return rebuilt.rstrip() + "\n", True


def link_changelog_commit_shas(root: Path) -> int:
    linked_count = 0

    for changelog_path in sorted(root.rglob("CHANGELOG.md")):
        if "legacy" in changelog_path.parts:
            continue

        content = changelog_path.read_text()
        match = VERSION_SECTION_RE.match(content)
        if match is None:
            continue

        header = match.group("header")
        section = match.group("section")
        after = content[match.end() :]

        linked_section = link_commit_shas_in_text(section)
        if linked_section == section:
            continue

        changelog_path.write_text(header + linked_section + after)
        linked_count += 1

    return linked_count


def fix_dependency_minor_changelogs(root: Path) -> int:
    fixed_count = 0

    for changelog_path in sorted(root.rglob("CHANGELOG.md")):
        if "legacy" in changelog_path.parts:
            continue

        content = changelog_path.read_text()
        match = VERSION_SECTION_RE.match(content)
        if match is None:
            continue

        header = match.group("header")
        section = match.group("section")
        after = content[match.end() :]

        fixed_section, changed = fix_dependency_minor_changelog_section(section)
        if not changed:
            continue

        changelog_path.write_text(header + fixed_section + after)
        fixed_count += 1

    return fixed_count


def fix_empty_core_changelog(root: Path) -> bool:
    changelog_path = root / "packages" / "core" / "CHANGELOG.md"
    content = changelog_path.read_text()

    def insert_alignment(match: re.Match[str]) -> str:
        return (
            match.group(1)
            + match.group(2)
            + CORE_CHANGELOG_ALIGNMENT_ENTRY
            + match.group(4)
        )

    new_content, count = EMPTY_CORE_CHANGELOG_SECTION_RE.subn(insert_alignment, content, count=1)
    if count == 0:
        return False

    changelog_path.write_text(new_content)
    return True


def read_core_version(root: Path) -> str:
    package_json = root / "packages" / "core" / "package.json"
    if not package_json.is_file():
        raise ReleasePrepError(f"Required file does not exist: {package_json}")

    try:
        version = json.loads(package_json.read_text())["version"]
    except (KeyError, TypeError, json.JSONDecodeError) as exc:
        raise ReleasePrepError(f"Could not read version from {package_json}") from exc

    return version


def run_changeset_version(root: Path) -> None:
    try:
        subprocess.run(["pnpm", "changeset", "version"], cwd=root, check=True)
    except FileNotFoundError as exc:
        raise ReleasePrepError(
            "pnpm is required to version packages. Install pnpm and run: cd typescript && pnpm install"
        ) from exc
    except subprocess.CalledProcessError as exc:
        raise ReleasePrepError(f"pnpm changeset version failed with exit code {exc.returncode}.") from exc


def main() -> int:
    args = parse_args()
    root = sdk_dir()
    changeset_dir = root / ".changeset"

    require_directory(changeset_dir)

    changesets = changeset_files(changeset_dir)
    if not changesets:
        print("No pending changesets found; release preparation skipped.")
        return 0

    current_version = read_core_version(root)
    sanitize_major_version_bumps(root, changesets, dry_run=args.dry_run)
    changeset_bodies_list = changeset_bodies(root, changesets)
    print_changeset_preview(changeset_bodies_list)
    warn_if_package_versions_deviate_from_core(root, label="pre-bump")

    if args.dry_run:
        preview_context = (
            temporarily_sanitized_major_bumps(root, changesets)
            if changesets_have_major_bumps(changesets)
            else nullcontext()
        )
        with preview_context:
            status = run_changeset_status(root)
            print_version_bump_preview(status.get("releases", []))
            warn_if_release_versions_deviate_from_core(
                status.get("releases", []), root, label="post-bump"
            )
            if core_would_get_alignment_entry(changesets, status.get("releases", [])):
                print(
                    "@x402/core changelog would receive an alignment-only entry "
                    "(no changesets target @x402/core)."
                )
                print()

        print(f"Current @x402/core version: {current_version}")
        print(f"Pending changesets: {len(changesets)}")
        print("Dry run complete; no files were changed.")
        return 0

    rewrite_changesets(root, changeset_bodies_list)
    core_in_changesets = changesets_include_core(changesets)
    run_changeset_version(root)
    if not core_in_changesets and fix_empty_core_changelog(root):
        print("Added alignment-only entry to @x402/core CHANGELOG.")
    fixed_changelogs = fix_dependency_minor_changelogs(root)
    if fixed_changelogs:
        print(
            f"Moved dependency-only changelog entries from Patch Changes to Minor Changes "
            f"in {fixed_changelogs} package(s)."
        )
    linked_changelogs = link_changelog_commit_shas(root)
    if linked_changelogs:
        print(f"Linked commit SHAs in {linked_changelogs} changelog(s).")
    target_version = read_core_version(root)
    warn_if_package_versions_deviate_from_core(root, label="post-bump")

    print(f"Prepared TypeScript SDK release (@x402/core {current_version} -> {target_version})")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleasePrepError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
