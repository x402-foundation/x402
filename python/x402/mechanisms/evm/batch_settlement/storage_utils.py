"""Atomic JSON file helpers used by file-backed channel storages."""

from __future__ import annotations

import json
import os
import secrets
from pathlib import Path
from typing import Any


def read_json_file(file_path: str | Path) -> Any | None:
    """Read and parse a JSON file. Returns ``None`` if the file is missing."""
    path = Path(file_path)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return None


def write_json_atomic(file_path: str | Path, value: Any) -> None:
    """Write `value` to `file_path` as JSON atomically.

    Writes to a temp file in the same directory, then renames over the target.
    Parent directories are created as needed.
    """
    path = Path(file_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    suffix = f".{os.getpid()}.{secrets.token_hex(4)}.tmp"
    tmp = path.with_name(f".{path.name}{suffix}")
    body = json.dumps(value, indent=2) + "\n"
    tmp.write_text(body, encoding="utf-8")
    try:
        tmp.replace(path)
    except OSError:
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        tmp.replace(path)


def delete_file(file_path: str | Path) -> None:
    """Remove a file, ignoring `FileNotFoundError`."""
    try:
        Path(file_path).unlink()
    except FileNotFoundError:
        pass


__all__ = ["read_json_file", "write_json_atomic", "delete_file"]
