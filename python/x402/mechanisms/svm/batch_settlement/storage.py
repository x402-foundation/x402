"""Atomic storage contracts; memory implementations are for a single process.

Production adapters must persist channel state, vouchers, and consumed request IDs.
The update callback must execute under an exclusive channel lock or transaction.
"""

from __future__ import annotations

from collections.abc import Callable
from copy import deepcopy
from threading import RLock
from typing import Protocol

from .errors import BatchError
from .types import BatchOperation, ChannelState


class ChannelStore(Protocol):
    def get(self, channel_id: str) -> ChannelState | None: ...

    def list(self) -> list[ChannelState]: ...

    def put(self, state: ChannelState) -> None: ...

    def update(
        self, channel_id: str, updater: Callable[[ChannelState | None], ChannelState]
    ) -> ChannelState: ...


class MemoryChannelStore:
    def __init__(self) -> None:
        self._channels: dict[str, ChannelState] = {}
        self._lock = RLock()

    def get(self, channel_id: str) -> ChannelState | None:
        with self._lock:
            return deepcopy(self._channels.get(channel_id))

    def list(self) -> list[ChannelState]:
        with self._lock:
            return deepcopy(list(self._channels.values()))

    def put(self, state: ChannelState) -> None:
        with self._lock:
            self._channels[state.channel_id] = deepcopy(state)

    def update(
        self, channel_id: str, updater: Callable[[ChannelState | None], ChannelState]
    ) -> ChannelState:
        with self._lock:
            state = updater(deepcopy(self._channels.get(channel_id)))
            if state.channel_id != channel_id:
                raise ValueError("Channel update changed its identity")
            self._channels[channel_id] = deepcopy(state)
            return deepcopy(state)


class BatchOperationStore(Protocol):
    def get(self, channel_id: str, request_id: str) -> BatchOperation | None: ...

    def reserve(self, channel_id: str, request_id: str, ceiling: int) -> bool:
        """Return True only for a newly consumed request ID; never recycle IDs."""
        ...

    def complete(self, operation: BatchOperation) -> None: ...

    def release(self, channel_id: str, request_id: str) -> None:
        """Retain a consumed-ID tombstone when work fails or is canceled."""
        ...


class MemoryBatchOperationStore:
    def __init__(self) -> None:
        self._operations: dict[tuple[str, str], BatchOperation] = {}
        self._lock = RLock()

    def get(self, channel_id: str, request_id: str) -> BatchOperation | None:
        with self._lock:
            return deepcopy(self._operations.get((channel_id, request_id)))

    def reserve(self, channel_id: str, request_id: str, ceiling: int) -> bool:
        with self._lock:
            key = (channel_id, request_id)
            existing = self._operations.get(key)
            if existing:
                if existing.ceiling != ceiling:
                    raise BatchError(BatchError.OPERATION_CEILING_CHANGED)
                return False
            self._operations[key] = BatchOperation(channel_id, request_id, ceiling)
            return True

    def complete(self, operation: BatchOperation) -> None:
        with self._lock:
            key = (operation.channel_id, operation.request_id)
            existing = self._operations.get(key)
            if (
                not existing
                or existing.status != "reserved"
                or existing.ceiling != operation.ceiling
            ):
                raise BatchError(BatchError.CHANNEL_BUSY)
            if operation.status != "completed":
                raise ValueError("Expected a completed operation")
            self._operations[key] = deepcopy(operation)

    def release(self, channel_id: str, request_id: str) -> None:
        # Capacity lives in ChannelStore. The operation stays consumed forever.
        pass
