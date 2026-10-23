"""Durable facilitator contracts and single-process memory implementations."""

from collections.abc import Sequence
from copy import deepcopy
from dataclasses import dataclass, field
from threading import RLock
from typing import Any, Protocol

from ....schemas import SettleResponse
from .errors import BatchError


@dataclass
class PaymentChannelRecord:
    network: str
    channel_id: str
    pay_to: str
    token_program: str
    receiver_authorizer: str = ""
    caller_identity: str = ""
    last_activity_at: float = 0
    channel_config: dict[str, Any] = field(default_factory=dict)


class PaymentChannelStorage(Protocol):
    def get(self, network: str, channel_id: str) -> PaymentChannelRecord | None: ...

    def list(self, network: str) -> list[PaymentChannelRecord]: ...

    def record(self, record: PaymentChannelRecord) -> None:
        """Atomically merge activity, rejecting conflicting nonempty receiver/caller bindings."""
        ...


class MemoryPaymentChannelStorage:
    def __init__(self) -> None:
        self._records: dict[tuple[str, str], PaymentChannelRecord] = {}
        self._lock = RLock()

    def get(self, network: str, channel_id: str) -> PaymentChannelRecord | None:
        with self._lock:
            return deepcopy(self._records.get((network, channel_id)))

    def list(self, network: str) -> list[PaymentChannelRecord]:
        with self._lock:
            return deepcopy([r for r in self._records.values() if r.network == network])

    def record(self, record: PaymentChannelRecord) -> None:
        with self._lock:
            key = record.network, record.channel_id
            existing = self._records.get(key)
            record = deepcopy(record)
            if existing:
                for field_name, reason in (
                    ("receiver_authorizer", BatchError.RECEIVER_AUTHORIZER_MISMATCH),
                    ("caller_identity", BatchError.DELEGATED_UNAUTHENTICATED),
                ):
                    previous, proposed = getattr(existing, field_name), getattr(record, field_name)
                    if previous and proposed and previous != proposed:
                        raise BatchError(reason)
                    setattr(record, field_name, previous or proposed)
                record.last_activity_at = max(existing.last_activity_at, record.last_activity_at)
                for name in ("pay_to", "token_program", "channel_config"):
                    if not getattr(record, name):
                        setattr(record, name, deepcopy(getattr(existing, name)))
            self._records[key] = record


@dataclass
class PendingSettlement:
    key: str
    network: str
    channel_ids: tuple[str, ...]
    signature: str
    wire_transaction: str
    last_valid_block_height: int
    kind: str
    payer: str
    metadata: dict[str, Any]
    response: SettleResponse | None = None


class BatchPendingSettlementStore(Protocol):
    def get(self, key: str) -> PendingSettlement | None: ...

    def latest(self, request_key: str) -> PendingSettlement | None:
        """Return the most recent sweep for a repeatable distribution request."""
        ...

    def find_pending(
        self, network: str, channel_ids: Sequence[str]
    ) -> PendingSettlement | None: ...

    def reserve(self, settlement: PendingSettlement) -> bool:
        """Atomically persist signed bytes and reserve every channel; False on contention.

        Persist before broadcast. Retain reservations until a confirmed outcome or a
        finalized block-height expiry plus a history lookup proves non-inclusion.
        """
        ...

    def complete(self, key: str, response: SettleResponse) -> None:
        """Idempotently persist an outcome and release only reservations still owned by key."""
        ...


class MemoryBatchPendingSettlementStore:
    def __init__(self) -> None:
        self._records: dict[str, PendingSettlement] = {}
        self._channels: dict[tuple[str, str], str] = {}
        self._lock = RLock()

    def get(self, key: str) -> PendingSettlement | None:
        with self._lock:
            return deepcopy(self._records.get(key))

    def latest(self, request_key: str) -> PendingSettlement | None:
        with self._lock:
            return next(
                (
                    deepcopy(record)
                    for record in reversed(list(self._records.values()))
                    if record.metadata.get("request_key") == request_key
                ),
                None,
            )

    def find_pending(self, network: str, channel_ids: Sequence[str]) -> PendingSettlement | None:
        with self._lock:
            for channel_id in channel_ids:
                key = self._channels.get((network, channel_id))
                if key:
                    return deepcopy(self._records[key])
            return None

    def reserve(self, settlement: PendingSettlement) -> bool:
        with self._lock:
            if settlement.key in self._records or any(
                (settlement.network, channel) in self._channels
                for channel in settlement.channel_ids
            ):
                return False
            self._records[settlement.key] = deepcopy(settlement)
            for channel in settlement.channel_ids:
                self._channels[settlement.network, channel] = settlement.key
            return True

    def complete(self, key: str, response: SettleResponse) -> None:
        with self._lock:
            record = self._records[key]
            if record.response is not None:
                return
            record.response = deepcopy(response)
            record.wire_transaction = ""
            for channel in record.channel_ids:
                if self._channels.get((record.network, channel)) == key:
                    del self._channels[record.network, channel]
