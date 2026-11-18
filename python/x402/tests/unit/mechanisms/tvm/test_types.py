"""Tests for TVM payload and parsed data types."""

import pytest

pytest.importorskip("pytoniq_core")

from pytoniq_core import begin_cell

from x402.mechanisms.tvm import (
    ExactTvmPayload,
    ParsedJettonTransfer,
    ParsedTvmSettlement,
    TvmAccountState,
    TvmJettonWalletData,
    TvmRelayRequest,
)


class TestExactTvmPayload:
    """Test ExactTvmPayload serialization helpers."""

    def test_to_dict_should_return_expected_shape(self):
        """to_dict should use public JSON field names."""
        payload = ExactTvmPayload(
            settlement_boc="base64-boc==",
            asset="0:" + "1" * 64,
        )

        assert payload.to_dict() == {
            "settlementBoc": "base64-boc==",
            "asset": "0:" + "1" * 64,
        }

    def test_from_dict_should_create_payload_from_dict(self):
        """from_dict should hydrate the dataclass from JSON field names."""
        payload = ExactTvmPayload.from_dict(
            {
                "settlementBoc": "base64-boc==",
                "asset": "0:" + "2" * 64,
            }
        )

        assert payload.settlement_boc == "base64-boc=="
        assert payload.asset == "0:" + "2" * 64

    def test_round_trip_serialization(self):
        """Should preserve data through serialization round-trip."""
        original = ExactTvmPayload(
            settlement_boc="payload==",
            asset="0:" + "3" * 64,
        )

        restored = ExactTvmPayload.from_dict(original.to_dict())

        assert restored == original

    def test_from_dict_should_reject_missing_settlement_boc(self):
        """from_dict should reject payloads without settlementBoc."""
        with pytest.raises(ValueError, match="settlementBoc.*required"):
            ExactTvmPayload.from_dict({"asset": "0:" + "2" * 64})

    def test_from_dict_should_reject_empty_asset(self):
        """from_dict should reject payloads with an empty asset."""
        with pytest.raises(ValueError, match="asset.*required"):
            ExactTvmPayload.from_dict(
                {
                    "settlementBoc": "base64-boc==",
                    "asset": "   ",
                }
            )


class TestParsedTypes:
    """Test TVM parsed settlement dataclasses."""

    def test_should_store_account_state_data(self):
        """Account state dataclass should retain provided fields."""
        state = TvmAccountState(
            address="0:" + "4" * 64,
            balance=123,
            is_active=True,
            is_frozen=False,
            is_uninitialized=False,
            state_init=None,
        )

        assert state.address == "0:" + "4" * 64
        assert state.balance == 123
        assert state.is_active is True

    def test_should_store_jetton_wallet_data(self):
        """Jetton wallet dataclass should retain provided fields."""
        wallet = TvmJettonWalletData(
            address="0:" + "5" * 64,
            balance=456,
            owner="0:" + "6" * 64,
            jetton_minter="0:" + "7" * 64,
        )

        assert wallet.balance == 456
        assert wallet.owner == "0:" + "6" * 64

    def test_should_store_relay_request_and_parsed_settlement(self):
        """Parsed transfer/settlement dataclasses should accept cell payloads."""
        cell = begin_cell().store_uint(1, 1).end_cell()
        relay_request = TvmRelayRequest(
            destination="0:" + "8" * 64,
            body=cell,
            state_init=None,
        )
        transfer = ParsedJettonTransfer(
            source_wallet="0:" + "9" * 64,
            destination="0:" + "a" * 64,
            response_destination=None,
            jetton_amount=1000,
            attached_ton_amount=2000,
            forward_ton_amount=1,
            forward_payload=cell,
            body_hash=b"hash",
        )
        settlement = ParsedTvmSettlement(
            payer="0:" + "c" * 64,
            wallet_id=1,
            valid_until=2,
            seqno=3,
            settlement_hash="hash-1",
            body=cell,
            signed_slice_hash=b"slice",
            signature=b"sig",
            state_init=None,
            transfer=transfer,
        )

        assert relay_request.body == cell
        assert settlement.transfer.attached_ton_amount == 2000
        assert settlement.transfer.jetton_amount == 1000
        assert settlement.signature == b"sig"
