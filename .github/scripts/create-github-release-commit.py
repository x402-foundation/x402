#!/usr/bin/env python3
"""Create a GitHub-verified bot commit through the GraphQL API.

Generic release helper. It takes a branch, a commit message, and a set of paths, 
then creates a branch and a verified commit containing the current local contents of those paths. 
Stdlib-only so it runs on CI runners via `python3` without any toolchain setup.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import subprocess
import sys
from pathlib import Path

CREATE_COMMIT_MUTATION = """
mutation($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
    }
  }
}
"""


class GitHubCommitError(RuntimeError):
    """Raised when the GitHub API commit cannot be created."""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Create a GitHub-verified commit from local file changes."
    )
    parser.add_argument("--branch", required=True, help="Release branch to create and commit to.")
    parser.add_argument("--message", required=True, help="Commit message headline.")
    parser.add_argument("paths", nargs="+", help="Files or directories to include in the commit.")
    return parser.parse_args()


def run(command: list[str], *, input_text: str | None = None) -> str:
    try:
        completed = subprocess.run(
            command,
            check=True,
            capture_output=True,
            input=input_text,
            text=True,
        )
    except FileNotFoundError as exc:
        raise GitHubCommitError(f"Required command not found: {command[0]}") from exc
    except subprocess.CalledProcessError as exc:
        message = exc.stderr.strip() or exc.stdout.strip() or str(exc)
        raise GitHubCommitError(message) from exc

    return completed.stdout.strip()


def github_repository() -> str:
    repository = os.environ.get("GITHUB_REPOSITORY")
    if not repository:
        raise GitHubCommitError("GITHUB_REPOSITORY is required.")
    return repository


def changed_paths(paths: list[str]) -> list[str]:
    output = run(["git", "diff", "--name-only", "HEAD", "--", *paths])
    return output.splitlines()


def file_changes(paths: list[str]) -> dict[str, list[dict[str, str]]]:
    additions = []
    deletions = []

    for path in paths:
        file_path = Path(path)
        if file_path.is_file():
            additions.append(
                {
                    "path": path,
                    "contents": base64.b64encode(file_path.read_bytes()).decode(),
                }
            )
            continue

        deletions.append({"path": path})

    return {"additions": additions, "deletions": deletions}


def create_branch(repository: str, branch: str, head_sha: str) -> None:
    payload = json.dumps({"ref": f"refs/heads/{branch}", "sha": head_sha})
    run(
        ["gh", "api", "--method", "POST", f"repos/{repository}/git/refs", "--input", "-"],
        input_text=payload,
    )


def create_commit(
    repository: str,
    branch: str,
    message: str,
    expected_head: str,
    changes: dict[str, list[dict[str, str]]],
) -> str:
    request = {
        "query": CREATE_COMMIT_MUTATION,
        "variables": {
            "input": {
                "branch": {
                    "repositoryNameWithOwner": repository,
                    "branchName": branch,
                },
                "message": {"headline": message},
                "fileChanges": changes,
                "expectedHeadOid": expected_head,
            }
        },
    }

    return run(
        [
            "gh",
            "api",
            "graphql",
            "--method",
            "POST",
            "--input",
            "-",
            "--jq",
            ".data.createCommitOnBranch.commit.url",
        ],
        input_text=json.dumps(request),
    )


def main() -> int:
    args = parse_args()
    repository = github_repository()
    head_sha = run(["git", "rev-parse", "HEAD"])
    paths = changed_paths(args.paths)
    if not paths:
        raise GitHubCommitError("No changed paths found.")

    create_branch(repository, args.branch, head_sha)
    commit_url = create_commit(
        repository,
        args.branch,
        args.message,
        head_sha,
        file_changes(paths),
    )
    print(commit_url)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except GitHubCommitError as exc:
        print(f"error: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
