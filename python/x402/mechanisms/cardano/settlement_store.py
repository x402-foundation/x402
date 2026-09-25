"""Atomic claims for broadcast-once settlement and Masumi terms binding."""

from __future__ import annotations

from dataclasses import dataclass
from threading import Lock
from typing import Literal, Protocol

DEFAULT_SETTLEMENT_STORE_ENTRIES = 4096
CardanoSettlementClaimResult = Literal[
    "fresh", "in-flight", "submitted", "rejected", "terms-conflict", "capacity-exceeded"
]


@dataclass(frozen=True)
class CardanoSettlementClaim:
    tx_hash: str
    owner_token: str
    terms_digest: str | None = None


class CardanoSettlementStore(Protocol):
    def claim_settlement(self, claim: CardanoSettlementClaim) -> CardanoSettlementClaimResult: ...

    def mark_submitted(self, tx_hash: str, owner_token: str) -> None: ...

    def mark_rejected(self, tx_hash: str, owner_token: str) -> None: ...

    def release_claim(self, tx_hash: str, owner_token: str) -> None: ...


@dataclass
class _SubmissionRecord:
    claim: CardanoSettlementClaim
    state: Literal["in-flight", "submitted", "rejected"] = "in-flight"


class InMemoryCardanoSettlementStore:
    """Bounded process-local store. Multiple replicas need a shared implementation."""

    def __init__(self, max_entries: int = DEFAULT_SETTLEMENT_STORE_ENTRIES) -> None:
        if type(max_entries) is not int or max_entries <= 0:
            raise ValueError("max_entries must be a positive integer")
        self._max_entries = max_entries
        self._submissions: dict[str, _SubmissionRecord] = {}
        self._terms: dict[str, str] = {}
        self._lock = Lock()

    def claim_settlement(self, claim: CardanoSettlementClaim) -> CardanoSettlementClaimResult:
        with self._lock:
            existing_terms = self._terms.get(claim.terms_digest) if claim.terms_digest else None
            if existing_terms is not None and existing_terms != claim.tx_hash:
                return "terms-conflict"
            existing = self._submissions.get(claim.tx_hash)
            if existing is not None:
                if existing.claim.terms_digest != claim.terms_digest:
                    return "terms-conflict"
                return existing.state
            required = 1 + int(bool(claim.terms_digest and existing_terms is None))
            while len(self._submissions) + len(self._terms) + required > self._max_entries:
                settled = next(
                    (
                        tx_hash
                        for tx_hash, record in self._submissions.items()
                        if record.state != "in-flight"
                    ),
                    None,
                )
                if settled is None:
                    return "capacity-exceeded"
                self._remove(settled)
            if claim.terms_digest and existing_terms is None:
                self._terms[claim.terms_digest] = claim.tx_hash
            self._submissions[claim.tx_hash] = _SubmissionRecord(claim)
            return "fresh"

    def mark_submitted(self, tx_hash: str, owner_token: str) -> None:
        with self._lock:
            record = self._submissions.get(tx_hash)
            if record and record.claim.owner_token == owner_token:
                record.state = "submitted"

    def mark_rejected(self, tx_hash: str, owner_token: str) -> None:
        with self._lock:
            record = self._submissions.get(tx_hash)
            if record and record.claim.owner_token == owner_token:
                record.state = "rejected"

    def release_claim(self, tx_hash: str, owner_token: str) -> None:
        with self._lock:
            record = self._submissions.get(tx_hash)
            if record and record.claim.owner_token == owner_token and record.state == "in-flight":
                self._remove(tx_hash)

    def _remove(self, tx_hash: str) -> None:
        record = self._submissions.pop(tx_hash)
        digest = record.claim.terms_digest
        if digest and self._terms.get(digest) == tx_hash:
            del self._terms[digest]
