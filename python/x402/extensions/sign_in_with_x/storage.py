"""Storage interface for SIWX payment tracking."""

from __future__ import annotations

from typing import Protocol


class SIWxStorage(Protocol):
    """Tracks paid addresses and optional nonce usage."""

    def has_paid(self, resource: str, address: str) -> bool: ...

    def record_payment(self, resource: str, address: str) -> None: ...

    def has_used_nonce(self, nonce: str) -> bool: ...

    def record_nonce(self, nonce: str) -> None: ...


class InMemorySIWxStorage:
    """In-memory implementation of SIWxStorage."""

    def __init__(self) -> None:
        self._paid_addresses: dict[str, set[str]] = {}

    def has_paid(self, resource: str, address: str) -> bool:
        return address.lower() in (self._paid_addresses.get(resource) or set())

    def record_payment(self, resource: str, address: str) -> None:
        if resource not in self._paid_addresses:
            self._paid_addresses[resource] = set()
        self._paid_addresses[resource].add(address.lower())
