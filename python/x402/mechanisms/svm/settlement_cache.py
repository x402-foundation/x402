"""Thread-safe in-memory cache for deduplicating concurrent settlement requests.

A single instance should be shared across V1 and V2 facilitator scheme
instances so that a transaction submitted through one protocol version is
also deduplicated on the other.
"""

import threading
import time

from .constants import SETTLEMENT_TTL_SECONDS


class SettlementCache:
    """In-memory cache for deduplicating concurrent settlement requests.

    Thread-safe: all public methods acquire an internal lock.
    """

    def __init__(self) -> None:
        self._entries: dict[str, float] = {}
        self._lock = threading.Lock()

    def is_duplicate(self, key: str) -> bool:
        """Return ``True`` if *key* is already pending settlement (duplicate).

        When ``False`` the key is recorded as newly pending.
        Callers should reject the settlement when this returns ``True``.
        """
        with self._lock:
            self._prune()
            if key in self._entries:
                return True
            self._entries[key] = time.monotonic()
            return False

    # Exposed for testing (e.g. backdating entries to simulate TTL expiry).
    @property
    def entries(self) -> dict[str, float]:
        """Direct access to the underlying dict — use only in tests."""
        return self._entries

    def _prune(self) -> None:
        """Remove entries older than the settlement TTL. Caller must hold _lock."""
        cutoff = time.monotonic() - SETTLEMENT_TTL_SECONDS
        expired = []
        for k, ts in self._entries.items():
            if ts < cutoff:
                expired.append(k)
            else:
                break
        for k in expired:
            del self._entries[k]
