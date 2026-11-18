"""Unit tests for client channel deps and state reconciliation helpers."""

from __future__ import annotations

from types import SimpleNamespace
from typing import Any

import pytest

try:
    from eth_account import Account
    from eth_utils import to_checksum_address

    from x402.http.utils import encode_payment_response_header
    from x402.mechanisms.evm.batch_settlement.client.channel import (
        BatchSettlementClientDeps,
        build_channel_config,
        get_channel,
        has_channel,
        process_payment_response,
        update_channel_after_refund,
        update_channel_from_settle,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
        InMemoryClientChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.constants import MIN_WITHDRAW_DELAY
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.schemas import SettleResponse
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


NETWORK = "eip155:84532"


def _seed_channel(
    storage: InMemoryClientChannelStorage,
    channel_id: str,
    *,
    balance: str,
    charged_cumulative_amount: str,
) -> None:
    storage.set(
        channel_id.lower(),
        BatchSettlementClientContext(
            balance=balance,
            charged_cumulative_amount=charged_cumulative_amount,
        ),
    )


def _make_failed_settle(signer_address: str, extra: dict[str, Any] | None = None) -> SettleResponse:
    return SettleResponse(
        success=False,
        transaction="",
        network=NETWORK,
        payer=signer_address,
        error_reason="settlement_failed",
        extra=extra or {},
    )


class TestUpdateChannelFromSettle:
    def test_ignores_settle_responses_with_no_charged_amount_and_no_deposit(self):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000001"

        update_channel_from_settle(
            storage,
            {"server": {}, "local": {"channel_id": channel_id, "request_amount": "1000"}},
        )

        assert storage.get(channel_id) is None

    def test_does_not_process_a_failed_payment_response_header(self):
        signer = _signer()
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000001"
        response_header = encode_payment_response_header(
            _make_failed_settle(signer.address, {"chargedAmount": "1000"})
        )

        process_payment_response(
            storage,
            lambda name: response_header if name == "PAYMENT-RESPONSE" else None,
            {"channel_id": channel_id, "request_amount": "1000", "deposit_amount": "5000"},
        )

        assert storage.get(channel_id) is None

    def test_deletes_channel_record_after_a_full_refund(self):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000002"
        storage.set(
            channel_id.lower(),
            BatchSettlementClientContext(
                charged_cumulative_amount="1000",
                balance="5000",
            ),
        )

        update_channel_after_refund(storage, channel_id.lower())

        assert storage.get(channel_id.lower()) is None

    def test_subtracts_a_partial_refund_from_previous_local_balance(self):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000002"
        storage.set(
            channel_id.lower(),
            BatchSettlementClientContext(
                charged_cumulative_amount="1000",
                balance="10000",
            ),
        )

        update_channel_after_refund(storage, channel_id.lower(), "2000")

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.balance == "8000"
        assert ctx.charged_cumulative_amount == "1000"

    def test_deletes_local_state_when_a_partial_refund_is_capped_to_the_refundable_balance(
        self,
    ):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000002"
        storage.set(
            channel_id.lower(),
            BatchSettlementClientContext(
                charged_cumulative_amount="9000",
                balance="10000",
            ),
        )

        update_channel_after_refund(storage, channel_id.lower(), "2000")

        assert storage.get(channel_id.lower()) is None

    def test_rejects_charged_amount_greater_than_requirements_amount(self):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000005"
        _seed_channel(storage, channel_id, balance="50000", charged_cumulative_amount="0")

        with pytest.raises(ValueError, match="chargedAmount"):
            update_channel_from_settle(
                storage,
                {
                    "server": {"charged_amount": "20000"},
                    "local": {"channel_id": channel_id, "request_amount": "10000"},
                },
            )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "0"
        assert ctx.balance == "50000"

    def test_rejects_a_non_integer_charged_amount(self):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000005"
        _seed_channel(storage, channel_id, balance="50000", charged_cumulative_amount="0")

        with pytest.raises(ValueError, match="chargedAmount"):
            update_channel_from_settle(
                storage,
                {
                    "server": {"charged_amount": "10.5"},
                    "local": {"channel_id": channel_id, "request_amount": "10000"},
                },
            )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "0"

    def test_adds_payload_deposit_amount_to_local_balance(self):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000008"

        update_channel_from_settle(
            storage,
            {
                "server": {"charged_amount": "10000"},
                "local": {
                    "channel_id": channel_id,
                    "request_amount": "10000",
                    "deposit_amount": "50000",
                },
            },
        )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "10000"
        assert ctx.balance == "50000"

    def test_persists_an_honest_previous_plus_charged_amount_when_extra_cumulative_is_omitted(
        self,
    ):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000007"
        _seed_channel(storage, channel_id, balance="50000", charged_cumulative_amount="0")

        update_channel_from_settle(
            storage,
            {
                "server": {"charged_amount": "10000"},
                "local": {"channel_id": channel_id, "request_amount": "10000"},
            },
        )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "10000"
        assert ctx.balance == "50000"

    def test_persists_when_extra_charged_cumulative_amount_matches_previous_plus_charged_amount(
        self,
    ):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000007"
        _seed_channel(storage, channel_id, balance="50000", charged_cumulative_amount="0")

        update_channel_from_settle(
            storage,
            {
                "server": {"charged_amount": "10000", "charged_cumulative_amount": "10000"},
                "local": {"channel_id": channel_id, "request_amount": "10000"},
            },
        )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "10000"
        assert ctx.balance == "50000"

    def test_writes_nothing_when_extra_charged_cumulative_amount_disagrees_including_deposit(
        self,
    ):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000009"
        _seed_channel(storage, channel_id, balance="50000", charged_cumulative_amount="0")

        update_channel_from_settle(
            storage,
            {
                "server": {"charged_amount": "10000", "charged_cumulative_amount": "40000"},
                "local": {
                    "channel_id": channel_id,
                    "request_amount": "10000",
                    "deposit_amount": "1000",
                },
            },
        )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "0"
        assert ctx.balance == "50000"

    def test_writes_nothing_when_extra_charged_cumulative_amount_is_not_a_non_negative_integer(
        self,
    ):
        storage = InMemoryClientChannelStorage()
        channel_id = "0xabc1230000000000000000000000000000000000000000000000000000000009"
        _seed_channel(storage, channel_id, balance="50000", charged_cumulative_amount="0")

        update_channel_from_settle(
            storage,
            {
                "server": {"charged_amount": "10000", "charged_cumulative_amount": "10.5"},
                "local": {
                    "channel_id": channel_id,
                    "request_amount": "10000",
                    "deposit_amount": "1000",
                },
            },
        )

        ctx = storage.get(channel_id.lower())
        assert ctx is not None
        assert ctx.charged_cumulative_amount == "0"
        assert ctx.balance == "50000"


class TestHasAndGetChannel:
    def test_get_returns_record_case_insensitively(self):
        storage = InMemoryClientChannelStorage()
        storage.set(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            BatchSettlementClientContext(balance="100"),
        )
        assert (
            get_channel(
                storage, "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
            )
            is not None
        )

    def test_has_channel(self):
        storage = InMemoryClientChannelStorage()
        assert not has_channel(
            storage, "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        )
        storage.set(
            "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            BatchSettlementClientContext(balance="100"),
        )
        assert has_channel(
            storage, "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
        )
