"""Atomic storage of issued Masumi quotes and their claimed transaction."""

from collections.abc import Callable
from dataclasses import dataclass
from threading import Lock
from typing import Literal, Protocol

from .....schemas import PaymentRequirements

DEFAULT_MASUMI_TERMS_STORAGE_ENTRIES = 10_000


@dataclass(frozen=True)
class MasumiTerms:
    terms_digest: str
    requirements: PaymentRequirements
    claimed_tx_hash: str | None = None


@dataclass(frozen=True)
class MasumiTermsUpdateResult:
    terms: MasumiTerms | None
    status: Literal["updated", "unchanged", "deleted"]


class MasumiTermsStorage(Protocol):
    def get(self, terms_digest: str) -> MasumiTerms | None: ...
    def update_terms(
        self, terms_digest: str, update: Callable[[MasumiTerms | None], MasumiTerms | None]
    ) -> MasumiTermsUpdateResult: ...


class InMemoryMasumiTermsStorage:
    def __init__(self, max_entries: int = DEFAULT_MASUMI_TERMS_STORAGE_ENTRIES):
        if type(max_entries) is not int or max_entries <= 0 or max_entries > 2**53 - 1:
            raise ValueError("max_entries must be a positive safe integer")
        self._max_entries = max_entries
        self._terms: dict[str, MasumiTerms] = {}
        self._lock = Lock()

    def get(self, terms_digest: str) -> MasumiTerms | None:
        with self._lock:
            return self._terms.get(terms_digest)

    def update_terms(
        self, terms_digest: str, update: Callable[[MasumiTerms | None], MasumiTerms | None]
    ) -> MasumiTermsUpdateResult:
        with self._lock:
            current = self._terms.get(terms_digest)
            next_value = update(current)
            if next_value is current:
                return MasumiTermsUpdateResult(current, "unchanged")
            if next_value is None:
                self._terms.pop(terms_digest, None)
                return MasumiTermsUpdateResult(None, "deleted" if current else "unchanged")
            self._terms[terms_digest] = next_value
            while len(self._terms) > self._max_entries:
                del self._terms[next(iter(self._terms))]
            return MasumiTermsUpdateResult(next_value, "updated")
