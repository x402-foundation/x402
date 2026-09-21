"""Atomic settlement claims and Masumi replay bindings."""

from concurrent.futures import ThreadPoolExecutor

import pytest


def test_concurrent_claim_has_one_owner():
    from x402.mechanisms.cardano.settlement_store import (
        CardanoSettlementClaim,
        InMemoryCardanoSettlementStore,
    )

    store = InMemoryCardanoSettlementStore()
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(
            pool.map(
                lambda i: store.claim_settlement(CardanoSettlementClaim("tx", str(i))), range(32)
            )
        )
    assert results.count("fresh") == 1
    assert results.count("in-flight") == 31


def test_terms_binding_survives_submission_and_rejection():
    from x402.mechanisms.cardano.settlement_store import (
        CardanoSettlementClaim,
        InMemoryCardanoSettlementStore,
    )

    for terminal in ("mark_submitted", "mark_rejected"):
        store = InMemoryCardanoSettlementStore()
        assert store.claim_settlement(CardanoSettlementClaim("tx", "owner", "terms")) == "fresh"
        getattr(store, terminal)("tx", "other")
        assert store.claim_settlement(CardanoSettlementClaim("tx", "next", "terms")) == "in-flight"
        getattr(store, terminal)("tx", "owner")
        store.release_claim("tx", "owner")
        assert store.claim_settlement(CardanoSettlementClaim("tx", "next", "terms")) == (
            "submitted" if terminal == "mark_submitted" else "rejected"
        )
        assert (
            store.claim_settlement(CardanoSettlementClaim("tx2", "next", "terms"))
            == "terms-conflict"
        )
        assert store.claim_settlement(CardanoSettlementClaim("tx", "next")) == "terms-conflict"


def test_capacity_preserves_inflight_and_evicts_settled():
    from x402.mechanisms.cardano.settlement_store import (
        CardanoSettlementClaim,
        InMemoryCardanoSettlementStore,
    )

    store = InMemoryCardanoSettlementStore(max_entries=2)
    assert store.claim_settlement(CardanoSettlementClaim("tx", "a", "terms")) == "fresh"
    assert store.claim_settlement(CardanoSettlementClaim("tx2", "b")) == "capacity-exceeded"
    store.mark_submitted("tx", "a")
    assert store.claim_settlement(CardanoSettlementClaim("tx2", "b", "terms2")) == "fresh"
    store.release_claim("tx2", "wrong")
    assert store.claim_settlement(CardanoSettlementClaim("tx3", "c", "terms2")) == "terms-conflict"
    store.release_claim("tx2", "b")
    assert store.claim_settlement(CardanoSettlementClaim("tx3", "c", "terms2")) == "fresh"


@pytest.mark.parametrize("value", [0, -1, True, 1.5])
def test_invalid_capacity(value):
    from x402.mechanisms.cardano.settlement_store import InMemoryCardanoSettlementStore

    with pytest.raises(ValueError):
        InMemoryCardanoSettlementStore(value)
