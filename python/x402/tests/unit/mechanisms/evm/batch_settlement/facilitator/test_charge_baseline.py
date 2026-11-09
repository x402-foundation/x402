"""Facilitator verify must require the voucher to advance totalClaimed by at least the price."""

from __future__ import annotations

from types import SimpleNamespace

import pytest

try:
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
        ERR_DEPOSIT_PAYLOAD,
        ERR_VOUCHER_PAYLOAD,
    )
    from x402.mechanisms.evm.batch_settlement.facilitator import deposit as deposit_mod
    from x402.mechanisms.evm.batch_settlement.facilitator import voucher as voucher_mod
    from x402.mechanisms.evm.batch_settlement.types import (
        ChannelConfig,
        ChannelState,
        DepositFields,
        DepositPayload,
        VoucherFields,
    )
    from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
    from x402.schemas import PaymentRequirements
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)

NETWORK = "eip155:8453"
ASSET = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
PRICE = 1000


def _config() -> ChannelConfig:
    return ChannelConfig(
        payer="0x1111111111111111111111111111111111111111",
        payer_authorizer="0x2222222222222222222222222222222222222222",
        receiver="0x3333333333333333333333333333333333333333",
        receiver_authorizer="0x4444444444444444444444444444444444444444",
        token=ASSET,
        withdraw_delay=900,
        salt="0x" + "00" * 31 + "01",
    )


def _requirements(amount: str = str(PRICE)) -> PaymentRequirements:
    return PaymentRequirements(
        scheme="batch-settlement",
        network=NETWORK,
        asset=ASSET,
        amount=amount,
        pay_to="0x3333333333333333333333333333333333333333",
        max_timeout_seconds=60,
        extra={},
    )


def _voucher_payload(max_claimable: int, payload_type: str = "voucher") -> dict:
    return {
        "type": payload_type,
        "channelConfig": _config().to_dict(),
        "voucher": {
            "channelId": compute_channel_id(_config(), NETWORK),
            "maxClaimableAmount": str(max_claimable),
            "signature": "0x" + "11" * 65,
        },
    }


@pytest.fixture
def voucher_env(monkeypatch):
    monkeypatch.setattr(voucher_mod, "validate_channel_config", lambda *a, **k: None)
    monkeypatch.setattr(
        voucher_mod, "verify_batch_settlement_voucher_typed_data", lambda *a, **k: True
    )

    def set_state(balance: int, total_claimed: int) -> None:
        monkeypatch.setattr(
            voucher_mod,
            "read_channel_state",
            lambda *a, **k: ChannelState(
                balance=balance,
                total_claimed=total_claimed,
                withdraw_requested_at=0,
                refund_nonce=0,
            ),
        )

    return set_state


MALFORMED_AMOUNTS = ["", "abc", "-1", "+5", " 5", "5 ", "1.5", "0x10", "1_0", "٣"]


def _verify_voucher(max_claimable: int, payload_type: str = "voucher", amount: str = str(PRICE)):
    return voucher_mod.verify_voucher(
        SimpleNamespace(),  # type: ignore[arg-type]
        _voucher_payload(max_claimable, payload_type),
        _requirements(amount),
        _config(),
    )


class TestVoucherAdvancesByPrice:
    def test_shortfall_voucher_is_rejected(self, voucher_env):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(501)
        assert out.is_valid is False
        assert out.invalid_reason == ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED

    def test_voucher_one_atom_short_of_price_is_rejected(self, voucher_env):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(500 + PRICE - 1)
        assert out.is_valid is False
        assert out.invalid_reason == ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED

    def test_voucher_advancing_by_exactly_price_is_accepted(self, voucher_env):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(500 + PRICE)
        assert out.is_valid is True
        assert out.extra["totalClaimed"] == "500"

    def test_refund_at_total_claimed_is_exempt(self, voucher_env):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(500, payload_type="refund")
        assert out.is_valid is True

    def test_refund_below_total_claimed_is_rejected(self, voucher_env):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(499, payload_type="refund")
        assert out.is_valid is False
        assert out.invalid_reason == ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED

    def test_zero_price_voucher_at_total_claimed_is_rejected(self, voucher_env):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(500, amount="0")
        assert out.is_valid is False
        assert out.invalid_reason == ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED

    def test_zero_price_voucher_above_total_claimed_is_accepted(self, voucher_env):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(501, amount="0")
        assert out.is_valid is True

    @pytest.mark.parametrize("amount", MALFORMED_AMOUNTS)
    def test_malformed_requirements_amount_is_rejected(self, voucher_env, amount):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(1_500, amount=amount)
        assert out.is_valid is False
        assert out.invalid_reason == ERR_VOUCHER_PAYLOAD

    def test_refund_ignores_requirements_amount(self, voucher_env):
        voucher_env(balance=10_000, total_claimed=500)
        out = _verify_voucher(500, payload_type="refund", amount="not-a-number")
        assert out.is_valid is True


class _Result:
    def __init__(self, result):
        self.success = True
        self.result = result


def _deposit_payload(max_claimable: int, deposit_amount: int = 10_000) -> DepositPayload:
    payload = DepositPayload()
    payload.channel_config = _config()
    payload.voucher = VoucherFields(
        channel_id=compute_channel_id(_config(), NETWORK),
        max_claimable_amount=str(max_claimable),
        signature="0x" + "11" * 65,
    )
    payload.deposit = DepositFields(amount=str(deposit_amount), authorization=None)  # type: ignore[arg-type]
    return payload


@pytest.fixture
def deposit_env(monkeypatch):
    monkeypatch.setattr(deposit_mod, "validate_channel_config", lambda *a, **k: None)
    monkeypatch.setattr(
        deposit_mod, "verify_batch_settlement_voucher_typed_data", lambda *a, **k: True
    )
    monkeypatch.setattr(deposit_mod, "get_evm_chain_id", lambda *_: 8453)

    def set_state(channel_balance: int, total_claimed: int) -> None:
        monkeypatch.setattr(
            deposit_mod,
            "multicall",
            lambda *a, **k: [
                _Result((channel_balance, total_claimed)),
                _Result(10**9),
                _Result((0, 0)),
                _Result(0),
            ],
        )

    return set_state


class TestDepositAdvancesByPrice:
    def test_shortfall_deposit_is_rejected(self, deposit_env):
        deposit_env(channel_balance=500, total_claimed=500)
        out = deposit_mod._verify_shared_deposit_state(
            SimpleNamespace(),
            _deposit_payload(501),
            _requirements(),  # type: ignore[arg-type]
        )
        assert getattr(out, "is_valid", True) is False
        assert out.invalid_reason == ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED

    def test_deposit_advancing_by_exactly_price_is_accepted(self, deposit_env):
        deposit_env(channel_balance=500, total_claimed=500)
        out = deposit_mod._verify_shared_deposit_state(
            SimpleNamespace(),
            _deposit_payload(500 + PRICE),
            _requirements(),  # type: ignore[arg-type]
        )
        assert isinstance(out, deposit_mod._SharedDepositState)
        assert out.ch_total_claimed == 500

    def test_zero_price_deposit_at_total_claimed_is_rejected(self, deposit_env):
        deposit_env(channel_balance=1_000, total_claimed=500)
        out = deposit_mod._verify_shared_deposit_state(
            SimpleNamespace(),
            _deposit_payload(500),
            _requirements("0"),  # type: ignore[arg-type]
        )
        assert getattr(out, "is_valid", True) is False
        assert out.invalid_reason == ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED

    @pytest.mark.parametrize("amount", MALFORMED_AMOUNTS)
    def test_malformed_requirements_amount_is_rejected(self, deposit_env, amount):
        deposit_env(channel_balance=1_000, total_claimed=500)
        out = deposit_mod._verify_shared_deposit_state(
            SimpleNamespace(),
            _deposit_payload(1_500),
            _requirements(amount),  # type: ignore[arg-type]
        )
        assert getattr(out, "is_valid", True) is False
        assert out.invalid_reason == ERR_DEPOSIT_PAYLOAD
