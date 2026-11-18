"""Unit tests for the in-memory client-side channel storage."""

from __future__ import annotations

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
        InMemoryClientChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.errors import ERR_INVALID_CHANNEL_ID
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)

TEST_CH = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


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
        assert s.get(TEST_CH) is None

    def test_set_then_get(self):
        s = InMemoryClientChannelStorage()
        s.set(TEST_CH, _ctx("100"))
        got = s.get(TEST_CH)
        assert got is not None
        assert got.balance == "100"
        assert got.signature == "0xsig"

    def test_set_stores_a_copy(self):
        s = InMemoryClientChannelStorage()
        ctx = _ctx("100")
        s.set(TEST_CH, ctx)
        ctx.balance = "999"

        got = s.get(TEST_CH)
        assert got is not None and got.balance == "100"

    def test_get_returns_a_copy(self):
        s = InMemoryClientChannelStorage()
        s.set(TEST_CH, _ctx("100"))
        a = s.get(TEST_CH)
        assert a is not None
        a.balance = "999"
        b = s.get(TEST_CH)
        assert b is not None and b.balance == "100"

    def test_delete(self):
        s = InMemoryClientChannelStorage()
        s.set(TEST_CH, _ctx())
        s.delete(TEST_CH)
        assert s.get(TEST_CH) is None

    def test_delete_missing_is_noop_for_canonical(self):
        # Should not raise for a valid but absent key.
        InMemoryClientChannelStorage().delete(TEST_CH)

    def test_malformed_raises(self):
        s = InMemoryClientChannelStorage()
        with pytest.raises(ValueError, match=ERR_INVALID_CHANNEL_ID):
            s.get("missing")
        with pytest.raises(ValueError, match=ERR_INVALID_CHANNEL_ID):
            s.set("missing", _ctx())
        with pytest.raises(ValueError, match=ERR_INVALID_CHANNEL_ID):
            s.delete("missing")


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
