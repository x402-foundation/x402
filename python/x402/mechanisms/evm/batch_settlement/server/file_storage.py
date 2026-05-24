"""File-backed server-side channel storage."""

from __future__ import annotations

import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path

from ..storage_utils import read_json_file, write_json_atomic
from .storage import Channel, ChannelUpdate, ChannelUpdateResult


@dataclass
class FileChannelStorageOptions:
    directory: str


class FileChannelStorage:
    """File-backed `ChannelStorage` writing to `{root}/server/{channelId}.json`."""

    def __init__(self, options: FileChannelStorageOptions | str):
        if isinstance(options, str):
            self._root = options
        else:
            self._root = options.directory
        self._process_lock = threading.Lock()

    def _server_dir(self) -> Path:
        return Path(self._root) / "server"

    def _file_path(self, channel_id: str) -> Path:
        return self._server_dir() / f"{channel_id.lower()}.json"

    def get(self, channel_id: str) -> Channel | None:
        data = read_json_file(self._file_path(channel_id))
        if data is None:
            return None
        return Channel.from_dict(data)

    def list(self) -> list[Channel]:
        d = self._server_dir()
        if not d.exists():
            return []
        channels: list[Channel] = []
        for entry in sorted(d.iterdir(), key=lambda p: p.name):
            if entry.suffix != ".json":
                continue
            if entry.name.endswith(".lock"):
                continue
            try:
                data = read_json_file(entry)
            except FileNotFoundError:
                continue
            if data is None:
                continue
            channels.append(Channel.from_dict(data))
        return channels

    def update_channel(self, channel_id: str, update: ChannelUpdate) -> ChannelUpdateResult:
        path = self._file_path(channel_id)
        lock_path = Path(str(path) + ".lock")
        path.parent.mkdir(parents=True, exist_ok=True)
        with self._process_lock, _file_lock(lock_path):
            data = read_json_file(path)
            current = Channel.from_dict(data) if data is not None else None

            next_ch = update(current)
            if next_ch is current:
                return ChannelUpdateResult(channel=current, status="unchanged")

            if next_ch is None:
                had_value = current is not None
                try:
                    path.unlink()
                except FileNotFoundError:
                    pass
                return ChannelUpdateResult(
                    channel=None,
                    status="deleted" if had_value else "unchanged",
                )

            write_json_atomic(path, next_ch.to_dict())
            return ChannelUpdateResult(channel=next_ch, status="updated")


class _file_lock:  # noqa: N801 - module-private context manager
    """Cross-process file lock using O_CREAT | O_EXCL.

    Polls until the lock can be acquired. The lock is released when the
    context exits, even on exception. Stale locks are not auto-cleared;
    callers must shut down cleanly.
    """

    def __init__(self, lock_path: Path):
        self._lock_path = lock_path
        self._fd: int | None = None

    def __enter__(self) -> _file_lock:
        while True:
            try:
                self._fd = os.open(self._lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
                return self
            except FileExistsError:
                time.sleep(0.01)

    def __exit__(self, exc_type, exc, tb) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
        try:
            self._lock_path.unlink()
        except FileNotFoundError:
            pass


__all__ = ["FileChannelStorage", "FileChannelStorageOptions"]
