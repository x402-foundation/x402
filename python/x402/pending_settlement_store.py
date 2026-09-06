"""Pending-settlement store shared by EVM and SVM facilitator mechanisms.

Lets a facilitator-side mechanism remember a broadcast-but-not-yet-confirmed
transaction hash, keyed by a deterministic identifier derived from the payment
payload (e.g. an EIP-3009/Permit2 signature, or an SVM message hash). When a
settle attempt's receipt/confirmation wait fails, the mechanism stores the
broadcast hash here before returning a ``settlement_pending`` error. On a
subsequent settle attempt for the same payload (typically the resource
server's single automatic retry — see ``settle_with_pending_retry`` in
``server_base.py``), the mechanism checks this store first and, on a hit,
reconciles against the already-broadcast transaction instead of verifying and
broadcasting a second one.

``PendingSettlementStore`` is a ``Protocol`` — not a concrete type —
specifically so a multi-instance facilitator (running several replicas with
no session affinity) can supply a shared, network-backed implementation (e.g.
Redis) instead of the in-memory default, which only works when a retry
happens to land back on the same process. Implementations must be safe for
concurrent use.

Unlike the Go/TypeScript SDKs (where facilitator mechanism code is
network-bound and asynchronous throughout), this Python SDK's mechanism layer
(``verify``/``settle`` on every scheme class) is fully synchronous — see
``ExactEvmScheme.settle``, ``ExactSvmScheme.settle``, etc. This Protocol is
therefore intentionally synchronous too, matching the existing
``SettlementCache`` convention (``mechanisms/svm/settlement_cache.py``), so
mechanism code never needs to bridge sync/async. A network-backed
implementation is free to perform blocking I/O inside these methods.
"""

from __future__ import annotations

import threading
import time
from typing import Protocol, runtime_checkable

# Generic (scheme/network-agnostic) settle error reason meaning a transaction
# broadcast successfully but its receipt/confirmation wait failed —
# non-terminal, and always carries the broadcast transaction hash so a caller
# can reconcile onchain. Mirrors the EVM-scoped ERR_SETTLEMENT_PENDING
# constant (mechanisms/evm/constants.py); duplicated here as a plain string so
# core server/retry logic does not depend on the EVM mechanism package.
ERR_SETTLEMENT_PENDING = "settlement_pending"

# TTL applied by the default in-memory PendingSettlementStore implementation.
# A store implementation backed by a different mechanism (e.g. Redis, for a
# multi-instance facilitator) is free to use its own TTL — this constant only
# governs InMemoryPendingSettlementStore.
PENDING_SETTLEMENT_TTL_SECONDS = 300.0


@runtime_checkable
class PendingSettlementStore(Protocol):
    """Protocol for a pending-settlement store.

    Implementations must be safe for concurrent use.
    """

    def get(self, key: str) -> str | None:
        """Return the previously stored transaction hash for key, if any.

        Returns None when there is no entry (including one that has expired).
        """
        ...

    def set(self, key: str, tx_hash: str) -> None:
        """Record that key's payment broadcast tx_hash but is not yet confirmed.

        A subsequent set() for the same key overwrites the prior value.
        """
        ...

    def delete(self, key: str) -> None:
        """Remove any pending entry for key.

        Called once the transaction is confirmed (success) or the mechanism
        determines it terminally failed.
        """
        ...


class InMemoryPendingSettlementStore:
    """Default PendingSettlementStore implementation.

    A lock-protected, per-process dict with lazy TTL pruning (mirrors the
    shape of ``mechanisms/svm/settlement_cache.SettlementCache``). Never
    performs network I/O — ``get`` additionally prunes expired entries (O(n)
    in the number of currently-stored entries, which stays small since
    entries only exist while a settlement is genuinely pending), so every
    call adds no meaningful latency to the settle hot path.

    Suitable for single-instance facilitators; multi-instance deployments
    should inject a shared, network-backed PendingSettlementStore
    implementation instead (e.g. Redis).
    """

    def __init__(self) -> None:
        self._entries: dict[str, tuple[str, float]] = {}
        self._lock = threading.Lock()

    def get(self, key: str) -> str | None:
        with self._lock:
            self._prune()
            entry = self._entries.get(key)
            return entry[0] if entry is not None else None

    def set(self, key: str, tx_hash: str) -> None:
        with self._lock:
            self._entries[key] = (tx_hash, time.monotonic())

    def delete(self, key: str) -> None:
        with self._lock:
            self._entries.pop(key, None)

    @property
    def entries(self) -> dict[str, tuple[str, float]]:
        """Direct access to the underlying dict — use only in tests."""
        return self._entries

    def _prune(self) -> None:
        """Remove entries older than the TTL. Caller must hold ``_lock``.

        A set() can refresh an existing key's timestamp without moving its
        position in the dict, so (unlike SettlementCache, which only ever
        inserts new keys) this scans every entry rather than assuming
        insertion-order timestamps and breaking early.
        """
        cutoff = time.monotonic() - PENDING_SETTLEMENT_TTL_SECONDS
        expired = [key for key, (_, stored_at) in self._entries.items() if stored_at < cutoff]
        for key in expired:
            del self._entries[key]


__all__ = [
    "ERR_SETTLEMENT_PENDING",
    "PENDING_SETTLEMENT_TTL_SECONDS",
    "PendingSettlementStore",
    "InMemoryPendingSettlementStore",
]
