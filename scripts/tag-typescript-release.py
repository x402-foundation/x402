#!/usr/bin/env python3
"""Create and push the TypeScript SDK release tags.

Run from the repository root after the packages are published to npm:

    python3 scripts/tag-typescript-release.py
    python3 scripts/tag-typescript-release.py --dry-run

One tag is created per published package, using the version from that package's
``package.json`` (e.g. ``npm-@x402/core@v2.14.0``). 
Tags are pushed to the ``x402-foundation/x402.

By default every published package is tagged. Pass package names to tag only a
subset (e.g. when you published only some packages):

    python3 scripts/tag-typescript-release.py @x402/core @x402/extensions

Use ``--dry-run`` to print the tags that would be created and pushed without
changing anything.
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

VERSION_RE = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$")
RELEASE_REPOSITORY = "x402-foundation/x402"
RELEASE_REPOSITORY_URL = f"https://github.com/{RELEASE_REPOSITORY}.git"
RELEASE_BRANCH = "main"

# Published packages in release order (mirrors the publish workflows).
PUBLISHED_PACKAGES = [
    "@x402/core",
    "@x402/extensions",
    "@x402/evm",
    "@x402/svm",
    "@x402/avm",
    "@x402/aptos",
    "@x402/stellar",
    "@x402/hedera",
    "@x402/keeta",
    "@x402/near",
    "@x402/concordium",
    "@x402/tvm",
    "@x402/xrpl",
    "@x402/paywall",
    "@x402/axios",
    "@x402/fetch",
    "@x402/express",
    "@x402/hono",
    "@x402/next",
    "@x402/fastify",
    "@x402/mcp",
]


class ReleaseTagError(RuntimeError):
    """Raised when the release-tag inputs or git state are invalid."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create and push the TypeScript SDK release tags."
    )
    parser.add_argument(
        "packages",
        nargs="*",
        help="Package names to tag. Defaults to every published package.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the tags that would be created and pushed without changing anything.",
    )
    parser.add_argument(
        "--no-sign",
        action="store_true",
        help="Create annotated (unsigned) tags instead of signed tags.",
    )
    parser.add_argument(
        "--no-push",
        action="store_true",
        help="Create the tags locally but do not push them.",
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


def normalize_version(version: str) -> str:
    return version.removeprefix("v")


def validate_version(version: str) -> None:
    if VERSION_RE.fullmatch(version) is None:
        raise ReleaseTagError(f"Expected version in X.Y.Z format, got: {version}")


def package_versions(packages_dir: Path) -> dict[str, str]:
    """Map ``@x402/*`` package names to their declared version (excludes legacy)."""
    versions: dict[str, str] = {}
    for package_json in packages_dir.rglob("package.json"):
        if "legacy" in package_json.parts or "node_modules" in package_json.parts:
            continue
        try:
            data = json.loads(package_json.read_text())
            name = data["name"]
            version = data["version"]
        except (KeyError, TypeError, json.JSONDecodeError):
            continue
        versions[name] = version
    return versions


def selected_packages(requested: list[str]) -> list[str]:
    if not requested:
        return list(PUBLISHED_PACKAGES)

    unknown = [name for name in requested if name not in PUBLISHED_PACKAGES]
    if unknown:
        raise ReleaseTagError(
            "Unknown package(s): "
            + ", ".join(unknown)
            + ". Expected one of: "
            + ", ".join(PUBLISHED_PACKAGES)
        )
    return [name for name in PUBLISHED_PACKAGES if name in requested]


def release_tags(
    names: list[str], versions: dict[str, str]
) -> list[tuple[str, str]]:
    tags: list[tuple[str, str]] = []
    for name in names:
        version = versions.get(name)
        if version is None:
            raise ReleaseTagError(f"Could not find a version for package {name}")
        validate_version(normalize_version(version))
        version = normalize_version(version)
        tags.append(
            (
                f"npm-{name}@v{version}",
                f"Released {name} on npm as version v{version}",
            )
        )
    return tags


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
    remote: str,
    tags: list[tuple[str, str]],
    local: set[str],
    remote_existing: set[str],
) -> None:
    print(f"Release remote: {remote}")
    print(f"Tags ({len(tags)}):")
    for tag, _ in tags:
        marker = existing_marker(tag, local, remote_existing, remote)
        print(f"  - {tag}{marker}")


def main() -> int:
    args = parse_args()
    root = repo_root()
    packages_dir = root / "typescript" / "packages"
    if not packages_dir.is_dir():
        raise ReleaseTagError(f"Required directory does not exist: {packages_dir}")

    versions = package_versions(packages_dir)
    names = selected_packages(args.packages)
    tags = release_tags(names, versions)
    remote = resolve_release_remote(root, args.remote)

    local = existing_tags(root)
    remote_existing = remote_tags(root, remote)
    clashes = [tag for tag, _ in tags if tag in local or tag in remote_existing]

    print_plan(remote, tags, local, remote_existing)
    assert_head_matches_release_main(root, remote)

    if args.dry_run:
        if clashes:
            print(
                f"warning: {len(clashes)} tag(s) already exist (locally or on "
                f"{remote}): {', '.join(clashes)}"
            )
        print("Dry run complete; no tags were created or pushed.")
        return 0

    if clashes:
        raise ReleaseTagError(
            f"Tags already exist (locally or on {remote}): {', '.join(clashes)}"
        )

    for tag, message in tags:
        create_tag(root, tag, message, sign=not args.no_sign)
        print(f"Created tag {tag}")

    if args.no_push:
        print("Skipping push (--no-push).")
        return 0

    git_run(root, ["push", remote, *[tag for tag, _ in tags]])
    print(f"Pushed {len(tags)} tag(s) to {remote}.")
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
