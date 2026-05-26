"""Unit tests for client channel deps and state reconciliation helpers."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

try:
    from eth_account import Account
    from eth_utils import to_checksum_address

    from x402.mechanisms.evm.batch_settlement.client.channel import (
        BatchSettlementClientDeps,
        build_channel_config,
        get_channel,
        has_channel,
        process_settle_response,
        update_channel_after_refund,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
        InMemoryClientChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.constants import MIN_WITHDRAW_DELAY
    from x402.mechanisms.evm.signers import EthAccountSigner
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"


def _signer() -> EthAccountSigner:
    return EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY))


def _deps(payer_authorizer: str | None = None) -> BatchSettlementClientDeps:
    return BatchSettlementClientDeps(
        signer=_signer(),
        storage=InMemoryClientChannelStorage(),
        salt="0x" + "00" * 32,
        payer_authorizer=payer_authorizer,
    )


def _requirements(
    pay_to: str = "0x3333333333333333333333333333333333333333",
    asset: str = "0x5555555555555555555555555555555555555555",
    network: str = "eip155:84532",
    receiver_authorizer: str | None = "0x4444444444444444444444444444444444444444",
    withdraw_delay: Any = None,
) -> SimpleNamespace:
    extra: dict[str, Any] = {}
    if receiver_authorizer is not None:
        extra["receiverAuthorizer"] = receiver_authorizer
    if withdraw_delay is not None:
        extra["withdrawDelay"] = withdraw_delay
    return SimpleNamespace(
        pay_to=pay_to,
        asset=asset,
        network=network,
        amount="100",
        extra=extra,
    )


class TestBuildChannelConfig:
    def test_basic_config(self):
        cfg = build_channel_config(_deps(), _requirements())
        assert cfg.payer == to_checksum_address(_signer().address)
        assert cfg.payer_authorizer == cfg.payer  # default to payer
        assert cfg.receiver == to_checksum_address("0x3333333333333333333333333333333333333333")
        assert cfg.receiver_authorizer == to_checksum_address(
            "0x4444444444444444444444444444444444444444"
        )
        assert cfg.token == to_checksum_address("0x5555555555555555555555555555555555555555")
        assert cfg.withdraw_delay == MIN_WITHDRAW_DELAY

    def test_explicit_payer_authorizer(self):
        pa = "0x6666666666666666666666666666666666666666"
        cfg = build_channel_config(_deps(payer_authorizer=pa), _requirements())
        assert cfg.payer_authorizer == to_checksum_address(pa)

    def test_withdraw_delay_passthrough(self):
        cfg = build_channel_config(_deps(), _requirements(withdraw_delay=3600))
        assert cfg.withdraw_delay == 3600

    def test_non_int_withdraw_delay_falls_back_to_min(self):
        cfg = build_channel_config(_deps(), _requirements(withdraw_delay="3600"))
        assert cfg.withdraw_delay == MIN_WITHDRAW_DELAY

    def test_missing_receiver_authorizer_raises(self):
        with pytest.raises(ValueError, match="receiverAuthorizer"):
            build_channel_config(_deps(), _requirements(receiver_authorizer=None))

    def test_zero_receiver_authorizer_raises(self):
        with pytest.raises(ValueError, match="receiverAuthorizer"):
            build_channel_config(
                _deps(),
                _requirements(receiver_authorizer="0x" + "00" * 20),
            )


def _settle_response(extra: dict[str, Any] | None) -> SimpleNamespace:
    return SimpleNamespace(extra=extra)


class TestProcessSettleResponse:
    def test_noop_on_missing_channel_state(self):
        storage = InMemoryClientChannelStorage()
        process_settle_response(storage, _settle_response(None))
        process_settle_response(storage, _settle_response({}))
        assert storage.get("0xabc") is None

    def test_creates_context_when_absent(self):
        storage = InMemoryClientChannelStorage()
        process_settle_response(
            storage,
            _settle_response(
                {
                    "channelState": {
                        "channelId": "0xABC",
                        "balance": "1000",
                        "totalClaimed": "100",
                        "chargedCumulativeAmount": "100",
                    }
                }
            ),
        )
        got = storage.get("0xabc")
        assert got is not None
        assert got.balance == "1000"
        assert got.total_claimed == "100"
        assert got.charged_cumulative_amount == "100"

    def test_updates_existing_context_in_place(self):
        storage = InMemoryClientChannelStorage()
        storage.set(
            "0xabc",
            BatchSettlementClientContext(
                balance="2000",
                signed_max_claimable="50",
                signature="0xprev",
            ),
        )
        process_settle_response(
            storage,
            _settle_response(
                {
                    "channelState": {
                        "channelId": "0xabc",
                        "balance": "1000",
                        "totalClaimed": "100",
                        "chargedCumulativeAmount": "100",
                    }
                }
            ),
        )
        got = storage.get("0xabc")
        assert got is not None
        assert got.balance == "1000"
        # Unrelated fields are preserved.
        assert got.signed_max_claimable == "50"
        assert got.signature == "0xprev"


class TestUpdateChannelAfterRefund:
    def test_no_extra_deletes_record(self):
        storage = InMemoryClientChannelStorage()
        storage.set("0xabc", BatchSettlementClientContext(balance="100"))
        update_channel_after_refund(storage, "0xabc", None)
        assert storage.get("0xabc") is None

    def test_zero_balance_keeps_sentinel_record(self):
        storage = InMemoryClientChannelStorage()
        storage.set("0xabc", BatchSettlementClientContext(balance="100"))
        update_channel_after_refund(
            storage,
            "0xabc",
            {
                "channelState": {
                    "channelId": "0xabc",
                    "balance": "0",
                    "totalClaimed": "100",
                }
            },
        )
        # Full refund: sentinel kept so subsequent refund attempts fail locally
        # with "no remaining balance" rather than triggering unnecessary I/O.
        ctx = storage.get("0xabc")
        assert ctx is not None
        assert ctx.balance == "0"
        assert ctx.total_claimed == "100"

    def test_remaining_balance_updates_record(self):
        storage = InMemoryClientChannelStorage()
        storage.set("0xabc", BatchSettlementClientContext(balance="100"))
        update_channel_after_refund(
            storage,
            "0xabc",
            {
                "channelState": {
                    "channelId": "0xabc",
                    "balance": "30",
                    "totalClaimed": "70",
                    "chargedCumulativeAmount": "70",
                }
            },
        )
        got = storage.get("0xabc")
        assert got is not None
        assert got.balance == "30"
        assert got.total_claimed == "70"


class TestHasAndGetChannel:
    def test_get_returns_record_case_insensitively(self):
        storage = InMemoryClientChannelStorage()
        storage.set("0xabc", BatchSettlementClientContext(balance="100"))
        assert get_channel(storage, "0xABC") is not None

    def test_has_channel(self):
        storage = InMemoryClientChannelStorage()
        assert not has_channel(storage, "0xABC")
        storage.set("0xabc", BatchSettlementClientContext(balance="100"))
        assert has_channel(storage, "0xABC")
