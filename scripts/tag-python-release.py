#!/usr/bin/env python3
"""Create and push the Python SDK release tag.

Run from the repository root after the release is published to PyPI:

    python3 scripts/tag-python-release.py
    python3 scripts/tag-python-release.py --dry-run

The release version is read from ``python/x402/pyproject.toml`` and produces the
``pypi-x402@vX.Y.Z`` tag. 
The tag is pushed to the ``x402-foundation/x402`` remote. 
Use ``--dry-run`` to print the tag that would be created and pushed without changing anything.
"""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
from pathlib import Path

VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
PYPROJECT_VERSION_RE = re.compile(r'^version = "([^"]+)"$', re.MULTILINE)
RELEASE_REPOSITORY = "x402-foundation/x402"
RELEASE_REPOSITORY_URL = f"https://github.com/{RELEASE_REPOSITORY}.git"
RELEASE_BRANCH = "main"


class ReleaseTagError(RuntimeError):
    """Raised when the release-tag inputs or git state are invalid."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create and push the Python SDK release tag."
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the tag that would be created and pushed without changing anything.",
    )
    parser.add_argument(
        "--no-sign",
        action="store_true",
        help="Create an annotated (unsigned) tag instead of a signed tag.",
    )
    parser.add_argument(
        "--no-push",
        action="store_true",
        help="Create the tag locally but do not push it.",
    )
    parser.add_argument(
        "--remote",
        help=(
            "Override the git remote to push to. Defaults to the remote whose URL "
            f"points at {RELEASE_REPOSITORY}."
        ),
    )
    return parser.parse_args()


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def require_file(path: Path) -> None:
    if not path.is_file():
        raise ReleaseTagError(f"Required file does not exist: {path}")


def normalize_version(version: str) -> str:
    return version.removeprefix("v")


def validate_version(version: str) -> None:
    if VERSION_RE.fullmatch(version) is None:
        raise ReleaseTagError(f"Expected version in X.Y.Z format, got: {version}")


def extract_pyproject_version(path: Path) -> str:
    matches = PYPROJECT_VERSION_RE.findall(path.read_text())
    if len(matches) != 1:
        raise ReleaseTagError(
            f"Expected exactly one version in {path}, found {len(matches)}"
        )
    version = normalize_version(matches[0])
    validate_version(version)
    return version


def git_run(root: Path, command: list[str]) -> str:
    completed = subprocess.run(
        ["git", *command],
        cwd=root,
        check=True,
        capture_output=True,
        text=True,
    )
    return completed.stdout.strip()


def normalize_repo_url(url: str) -> str:
    """Reduce a git remote URL to its ``owner/repo`` form."""
    url = url.strip()
    url = url.removesuffix(".git")
    if url.startswith("git@"):
        url = url.split(":", 1)[-1]
    elif "://" in url:
        url = url.split("://", 1)[-1]
        url = url.split("/", 1)[-1] if "/" in url else url
    return url.lower()


def resolve_release_remote(root: Path, override: str | None) -> str:
    if override is not None:
        return override

    output = git_run(root, ["remote", "-v"])
    for line in output.splitlines():
        parts = line.split()
        if len(parts) < 2:
            continue
        name, url = parts[0], parts[1]
        if normalize_repo_url(url) == RELEASE_REPOSITORY.lower():
            return name

    raise ReleaseTagError(
        f"No git remote points at {RELEASE_REPOSITORY}. Add one with: "
        f"git remote add upstream {RELEASE_REPOSITORY_URL} (or pass --remote)."
    )


def existing_tags(root: Path) -> set[str]:
    output = git_run(root, ["tag", "--list"])
    return set(output.splitlines())


def remote_tags(root: Path, remote: str) -> set[str]:
    output = git_run(root, ["ls-remote", "--tags", remote])
    names: set[str] = set()
    for line in output.splitlines():
        parts = line.split("\t")
        if len(parts) != 2 or not parts[1].startswith("refs/tags/"):
            continue
        names.add(parts[1][len("refs/tags/") :].removesuffix("^{}"))
    return names


def existing_marker(
    tag: str, local: set[str], remote_existing: set[str], remote: str
) -> str:
    where = []
    if tag in local:
        where.append("locally")
    if tag in remote_existing:
        where.append(remote)
    if not where:
        return ""
    return f"  [ALREADY EXISTS: {', '.join(where)}]"


def assert_head_matches_release_main(root: Path, remote: str) -> None:
    """Refuse to tag unless HEAD is exactly the release remote's main head.

    Tags point at the currently checked-out commit, so tagging while ahead of or
    diverged from the release branch would publish the wrong commit."""
    try:
        git_run(root, ["fetch", remote, RELEASE_BRANCH])
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        detail = f": {stderr}" if stderr else ""
        raise ReleaseTagError(
            f"Could not fetch {remote}/{RELEASE_BRANCH}{detail}"
        ) from exc

    head = git_run(root, ["rev-parse", "HEAD"])
    target = git_run(root, ["rev-parse", "FETCH_HEAD"])
    if head != target:
        raise ReleaseTagError(
            f"HEAD ({head[:12]}) is not {remote}/{RELEASE_BRANCH} ({target[:12]}). "
            "Tags would point at the wrong commit. Check out the merged release "
            "commit before tagging:\n"
            f"  git fetch {remote} && git checkout {RELEASE_BRANCH} && "
            f"git reset --hard {remote}/{RELEASE_BRANCH}"
        )

    print(f"HEAD matches {remote}/{RELEASE_BRANCH} ({head[:12]}).")


def create_tag(root: Path, tag: str, message: str, *, sign: bool) -> None:
    sign_flag = "-s" if sign else "-a"
    git_run(root, ["tag", sign_flag, "-a", tag, "-m", message])


def print_plan(
    version: str,
    remote: str,
    tag: str,
    local: set[str],
    remote_existing: set[str],
) -> None:
    print(f"Python SDK release version: {version}")
    print(f"Release remote: {remote}")
    print("Tags:")
    marker = existing_marker(tag, local, remote_existing, remote)
    print(f"  - {tag} (annotated){marker}")


def main() -> int:
    args = parse_args()
    root = repo_root()
    pyproject = root / "python" / "x402" / "pyproject.toml"
    require_file(pyproject)

    version = extract_pyproject_version(pyproject)
    remote = resolve_release_remote(root, args.remote)
    tag = f"pypi-x402@v{version}"
    message = f"Released x402 on pypi as version v{version}"

    local = existing_tags(root)
    remote_existing = remote_tags(root, remote)
    clashes = tag in local or tag in remote_existing

    print_plan(version, remote, tag, local, remote_existing)
    assert_head_matches_release_main(root, remote)

    if args.dry_run:
        if clashes:
            print(f"warning: tag already exists (locally or on {remote}): {tag}")
        print("Dry run complete; no tags were created or pushed.")
        return 0

    if clashes:
        raise ReleaseTagError(
            f"Tag already exists (locally or on {remote}): {tag}"
        )

    create_tag(root, tag, message, sign=not args.no_sign)
    print(f"Created tag {tag}")

    if args.no_push:
        print("Skipping push (--no-push).")
        return 0

    git_run(root, ["push", remote, tag])
    print(f"Pushed {tag} to {remote}.")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ReleaseTagError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
    except subprocess.CalledProcessError as exc:
        stderr = (exc.stderr or "").strip()
        detail = f": {stderr}" if stderr else ""
        print(f"error: git command failed{detail}", file=sys.stderr)
        raise SystemExit(1) from exc
