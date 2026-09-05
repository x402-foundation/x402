"""Duplicate-settlement guard for XRPL payments."""

from __future__ import annotations

import threading
import time
from typing import Protocol

# Floor, and the margin added on top of a payment's own validity window. Sized
# to cover ledger-close variance and clock skew; matches the TypeScript
# mechanism, because too short a margin reopens the replay window the cache
# exists to close.
DEFAULT_SETTLEMENT_TTL_SECONDS = 120.0

# Smallest size at which expiry sweeps. Below it the mapping is too small for
# the scan to be worth deferring; above it the threshold tracks the surviving
# set, so the sweep stays amortised.
_MIN_SWEEP_THRESHOLD = 1024


class SettlementCacheLike(Protocol):
    """What the facilitator requires of a duplicate-settlement guard.

    The scheme spec requires deduplication across every process that serves
    ``/settle``, so a horizontally scaled deployment backs the guard with a
    shared atomic store rather than the in-process default. Any object with
    this method — a Redis ``SET NX EX`` wrapper, a database row with a
    uniqueness constraint — can be passed to the facilitator constructor.

    The one obligation is atomicity: test-and-record must be a single
    operation, because two concurrent settles of one payment must not both
    observe the key as absent.
    """

    def is_duplicate(self, key: str, ttl_seconds: float) -> bool:
        """Record a settlement key, reporting whether it was already present.

        Args:
            key: Settlement identity, normally the signed transaction hash.
            ttl_seconds: How long the entry must be retained.

        Returns:
            True if the key was already recorded, False after recording it.
        """


class SettlementCache:
    """Rejects a signed transaction that has already been submitted.

    XRPL submission is idempotent on the transaction hash: resubmitting a blob
    that already landed resolves ``tesSUCCESS`` again, so without this guard
    every concurrent ``/settle`` carrying the same blob reports success while
    one payment moves. The XRPL exact scheme makes the mitigation REQUIRED.

    An entry is retained until its transaction can no longer land, derived
    from ``maxTimeoutSeconds``, because a resubmission passes verification
    for as long as the original is landable. Access is guarded by a lock; the
    GIL does not make test-then-insert atomic, nor iteration safe against
    concurrent writes.

    This is a per-process guard: a horizontally scaled facilitator must back
    it with a shared atomic store. Memory is bounded by request rate times
    retention (evicting a live entry would re-admit the duplicate it exists to
    stop); :meth:`size` is exposed to monitor growth.
    """

    def __init__(self) -> None:
        self._entries: dict[str, float] = {}
        self._lock = threading.Lock()
        self._sweep_threshold = _MIN_SWEEP_THRESHOLD

    def is_duplicate(
        self,
        key: str,
        ttl_seconds: float = DEFAULT_SETTLEMENT_TTL_SECONDS,
        now: float | None = None,
    ) -> bool:
        """Record a settlement key, reporting whether it was already present.

        The check and the insert are performed under a lock, so concurrent
        callers cannot both observe the key as absent.

        Args:
            key: Settlement identity, normally the signed transaction hash.
            ttl_seconds: How long to retain the entry.
            now: Current time in seconds; defaults to the monotonic clock.

        Returns:
            True if the key was already recorded, False after recording it.
        """
        # Retention is a duration, so it is measured on a clock that cannot
        # step: a wall-clock jump would evict entries whose transactions can
        # still land.
        current = time.monotonic() if now is None else now
        with self._lock:
            self._prune(current)
            # The window, not the lazy sweep, decides: an entry past its
            # retention is treated as absent.
            expires_at = self._entries.get(key)
            if expires_at is not None and expires_at > current:
                return True
            self._entries[key] = current + ttl_seconds
            return False

    def size(self) -> int:
        """Return the number of retained entries, for monitoring growth.

        Returns:
            Count of entries currently held.
        """
        with self._lock:
            return len(self._entries)

    def _prune(self, now: float) -> None:
        """Drop expired entries once the mapping has grown past the threshold.

        Insertion order is not expiry order, so the sweep reads every entry --
        deferred until the mapping doubles, or a client minting distinct blobs
        gets an O(n) cost per request behind the lock. Retaining an expired
        entry until the next sweep is safe (verification rejects its
        transaction first); dropping a live one would not be.

        Callers must hold the lock.

        Args:
            now: Current time on the monotonic clock, in seconds.
        """
        if len(self._entries) < self._sweep_threshold:
            return
        self._entries = {key: expiry for key, expiry in self._entries.items() if expiry > now}
        self._sweep_threshold = max(_MIN_SWEEP_THRESHOLD, len(self._entries) * 2)
