"""Unit tests for the in-memory client-side channel storage."""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
        InMemoryClientChannelStorage,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


def _ctx(balance: str = "100") -> BatchSettlementClientContext:
    return BatchSettlementClientContext(
        charged_cumulative_amount="10",
        balance=balance,
        total_claimed="0",
        signed_max_claimable="10",
        signature="0xsig",
    )


class TestInMemoryClientChannelStorage:
    def test_get_missing_returns_none(self):
        s = InMemoryClientChannelStorage()
        assert s.get("missing") is None

    def test_set_then_get(self):
        s = InMemoryClientChannelStorage()
        s.set("k", _ctx("100"))
        got = s.get("k")
        assert got is not None
        assert got.balance == "100"
        assert got.signature == "0xsig"

    def test_set_stores_a_copy(self):
        s = InMemoryClientChannelStorage()
        ctx = _ctx("100")
        s.set("k", ctx)
        ctx.balance = "999"

        got = s.get("k")
        assert got is not None and got.balance == "100"

    def test_get_returns_a_copy(self):
        s = InMemoryClientChannelStorage()
        s.set("k", _ctx("100"))
        a = s.get("k")
        assert a is not None
        a.balance = "999"
        b = s.get("k")
        assert b is not None and b.balance == "100"

    def test_delete(self):
        s = InMemoryClientChannelStorage()
        s.set("k", _ctx())
        s.delete("k")
        assert s.get("k") is None

    def test_delete_missing_is_noop(self):
        # Should not raise.
        InMemoryClientChannelStorage().delete("missing")


class TestBatchSettlementClientContext:
    def test_to_dict_uses_camel_case(self):
        d = _ctx().to_dict()
        assert "chargedCumulativeAmount" in d
        assert "signedMaxClaimable" in d
        assert "totalClaimed" in d

    def test_to_dict_omits_none_fields(self):
        empty = BatchSettlementClientContext()
        assert empty.to_dict() == {}

    def test_round_trip(self):
        ctx = _ctx()
        assert BatchSettlementClientContext.from_dict(ctx.to_dict()) == ctx

    def test_extra_passthrough(self):
        d = {"balance": "100", "customField": "x", "another": [1, 2]}
        ctx = BatchSettlementClientContext.from_dict(d)
        assert ctx.balance == "100"
        assert ctx.extra == {"customField": "x", "another": [1, 2]}

        round_tripped = ctx.to_dict()
        assert round_tripped["customField"] == "x"
        assert round_tripped["another"] == [1, 2]
        assert round_tripped["balance"] == "100"

    def test_copy_is_independent(self):
        ctx = _ctx()
        c2 = ctx.copy()
        c2.balance = "9999"
        c2.extra["new"] = "val"
        assert ctx.balance == "100"
        assert "new" not in ctx.extra
