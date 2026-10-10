"""Client configuration and replaceable synchronous channel storage."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
from threading import RLock
from typing import Any, Protocol

from .trust import BatchServerSignedChannelsPolicy


class BatchClientChannelStorage(Protocol):
    """Persist an entire record atomically, including its unresolved payment."""

    def get(self, key: str) -> dict[str, Any] | None: ...
    def set(self, key: str, record: dict[str, Any]) -> None: ...
    def delete(self, key: str) -> None: ...


class InMemoryBatchClientChannelStorage:
    def __init__(self) -> None:
        self._records: dict[str, dict[str, Any]] = {}
        self._lock = RLock()

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            return deepcopy(self._records.get(key))

    def set(self, key: str, record: dict[str, Any]) -> None:
        with self._lock:
            self._records[key] = deepcopy(record)

    def delete(self, key: str) -> None:
        with self._lock:
            self._records.pop(key, None)


@dataclass(frozen=True)
class BatchDepositPolicy:
    deposit_multiplier: int = 5


@dataclass
class BatchSvmClientConfig:
    rpc_url: str | None = None
    deposit_amount: int | str | None = None
    deposit_policy: BatchDepositPolicy | None = None
    channel_storage: BatchClientChannelStorage | None = None
    salt: int | str = 0
    discover_channels: bool = True
    server_signed_channels_policy: BatchServerSignedChannelsPolicy | None = None


@dataclass
class OpenChannel:
    channel_id: str
    channel_config: dict[str, Any]
    deposit: int
    cumulative: int = 0


@dataclass
class PendingChannel:
    channel: OpenChannel
    confirmed: OpenChannel | None
    amount: int
    payload: dict[str, Any]
