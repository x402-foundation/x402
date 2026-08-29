"""Duplicate-settlement cache for Lightning payment hashes."""

from __future__ import annotations

import time

from .constants import DEFAULT_SETTLEMENT_TTL_SECONDS


class SettlementCache:
    """Tracks payment hashes that have already been accepted."""

    def __init__(self, default_ttl_seconds: float = DEFAULT_SETTLEMENT_TTL_SECONDS) -> None:
        self._default_ttl_seconds = default_ttl_seconds
        self.entries: dict[str, float] = {}

    def is_used(self, payment_hash: str) -> bool:
        """Return True if the payment hash is already marked as used."""
        self._prune()
        return payment_hash in self.entries

    def mark_used(self, payment_hash: str, ttl_seconds: float | None = None) -> bool:
        """Mark a payment hash as used, returning False if it was already present."""
        self._prune()
        if payment_hash in self.entries:
            return False

        ttl = ttl_seconds if ttl_seconds is not None else self._default_ttl_seconds
        self.entries[payment_hash] = time.time() + ttl
        return True

    def _prune(self) -> None:
        """Remove expired cache entries."""
        now = time.time()
        expired = [
            payment_hash for payment_hash, expires_at in self.entries.items() if expires_at <= now
        ]
        for payment_hash in expired:
            del self.entries[payment_hash]
