"""Unit tests for PendingSettlementStore and InMemoryPendingSettlementStore."""

from __future__ import annotations

from x402 import InMemoryPendingSettlementStore, PendingSettlementStore
from x402.pending_settlement_store import PENDING_SETTLEMENT_TTL_SECONDS


class TestInMemoryPendingSettlementStore:
    def test_get_returns_none_on_miss(self):
        store = InMemoryPendingSettlementStore()

        assert store.get("missing-key") is None

    def test_set_then_get_returns_stored_value(self):
        store = InMemoryPendingSettlementStore()

        store.set("key-1", "0xabc")

        assert store.get("key-1") == "0xabc"

    def test_set_overwrites_prior_value_for_same_key(self):
        store = InMemoryPendingSettlementStore()

        store.set("key-1", "0xabc")
        store.set("key-1", "0xdef")

        assert store.get("key-1") == "0xdef"

    def test_delete_removes_entry(self):
        store = InMemoryPendingSettlementStore()
        store.set("key-1", "0xabc")

        store.delete("key-1")

        assert store.get("key-1") is None

    def test_delete_on_missing_key_is_a_no_op(self):
        store = InMemoryPendingSettlementStore()

        store.delete("never-existed")  # must not raise

        assert store.get("never-existed") is None

    def test_distinct_keys_do_not_collide(self):
        store = InMemoryPendingSettlementStore()

        store.set("key-a", "0xaaa")
        store.set("key-b", "0xbbb")

        assert store.get("key-a") == "0xaaa"
        assert store.get("key-b") == "0xbbb"

    def test_entries_older_than_ttl_are_pruned_on_get(self):
        store = InMemoryPendingSettlementStore()
        store.set("expired", "0xabc")

        tx_hash, stored_at = store.entries["expired"]
        store.entries["expired"] = (tx_hash, stored_at - PENDING_SETTLEMENT_TTL_SECONDS - 1)

        assert store.get("expired") is None

    def test_fresh_entries_survive_pruning(self):
        store = InMemoryPendingSettlementStore()
        store.set("expired", "0xabc")
        store.set("fresh", "0xdef")

        tx_hash, stored_at = store.entries["expired"]
        store.entries["expired"] = (tx_hash, stored_at - PENDING_SETTLEMENT_TTL_SECONDS - 1)

        # Triggers a prune pass as a side effect of get().
        assert store.get("expired") is None
        assert store.get("fresh") == "0xdef"

    def test_prune_rescans_after_a_set_refreshes_an_existing_key(self):
        """A set() on an existing key must refresh its timestamp for pruning purposes,
        even though dict insertion order keeps the key in its original position."""
        store = InMemoryPendingSettlementStore()
        store.set("key-a", "0xaaa")
        store.set("key-b", "0xbbb")

        # Refresh key-a's timestamp well after key-b was inserted.
        store.set("key-a", "0xaaa2")

        # Backdate key-b (inserted first, but never refreshed) past the TTL.
        tx_hash, stored_at = store.entries["key-b"]
        store.entries["key-b"] = (tx_hash, stored_at - PENDING_SETTLEMENT_TTL_SECONDS - 1)

        # key-a must survive pruning despite being first in insertion order, because its
        # timestamp was refreshed after key-b's.
        assert store.get("key-a") == "0xaaa2"
        assert store.get("key-b") is None


class _StubPendingSettlementStore:
    """Minimal PendingSettlementStore implementation used to prove mechanism code only
    depends on the Protocol, never the concrete InMemoryPendingSettlementStore type."""

    def __init__(self) -> None:
        self.calls: list[tuple[str, ...]] = []
        self._data: dict[str, str] = {}

    def get(self, key: str) -> str | None:
        self.calls.append(("get", key))
        return self._data.get(key)

    def set(self, key: str, tx_hash: str) -> None:
        self.calls.append(("set", key, tx_hash))
        self._data[key] = tx_hash

    def delete(self, key: str) -> None:
        self.calls.append(("delete", key))
        self._data.pop(key, None)


class TestPendingSettlementStoreProtocol:
    def test_in_memory_store_satisfies_protocol(self):
        store: PendingSettlementStore = InMemoryPendingSettlementStore()

        assert isinstance(store, PendingSettlementStore)

    def test_stub_implementation_satisfies_protocol(self):
        store: PendingSettlementStore = _StubPendingSettlementStore()

        assert isinstance(store, PendingSettlementStore)

    def test_stub_implementation_is_usable_wherever_the_protocol_is_expected(self):
        def _round_trip(store: PendingSettlementStore) -> str | None:
            store.set("key", "0x123")
            value = store.get("key")
            store.delete("key")
            return value

        stub = _StubPendingSettlementStore()

        assert _round_trip(stub) == "0x123"
        assert stub.get("key") is None
        assert stub.calls == [
            ("set", "key", "0x123"),
            ("get", "key"),
            ("delete", "key"),
            ("get", "key"),
        ]
