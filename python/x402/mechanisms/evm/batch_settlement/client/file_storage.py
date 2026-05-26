"""File-backed client channel storage for the batch-settlement scheme."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from ..storage_utils import delete_file, read_json_file, write_json_atomic
from .storage import BatchSettlementClientContext, ClientChannelStorage


@dataclass
class FileChannelStorageOptions:
    """Configuration for a file-backed channel storage."""

    directory: str | Path


class FileClientChannelStorage(ClientChannelStorage):
    """File-backed client channel storage.

    Each channel's context is persisted to `{root}/client/{channelId}.json` so
    channel records survive process restarts.
    """

    def __init__(self, options: FileChannelStorageOptions):
        self._root = Path(options.directory)

    def get(self, key: str) -> BatchSettlementClientContext | None:
        data = read_json_file(self._file_path(key))
        if data is None:
            return None
        return BatchSettlementClientContext.from_dict(data)

    def set(self, key: str, context: BatchSettlementClientContext) -> None:
        write_json_atomic(self._file_path(key), context.to_dict())

    def delete(self, key: str) -> None:
        delete_file(self._file_path(key))

    def _file_path(self, key: str) -> Path:
        return self._root / "client" / f"{key.lower()}.json"


__all__ = ["FileChannelStorageOptions", "FileClientChannelStorage"]
