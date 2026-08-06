"""Unit tests for the client-side cooperative refund flow."""

from __future__ import annotations

import pytest

try:
    from eth_account import Account

    from x402.http.utils import (
        encode_payment_required_header,
        encode_payment_response_header,
    )
    from x402.mechanisms.evm.batch_settlement.client.channel import (
        BatchSettlementClientDeps,
    )
    from x402.mechanisms.evm.batch_settlement.client.refund import (
        RefundOptions,
        _normalize_refund_amount,
        _RefundResponse,
        refund_channel,
    )
    from x402.mechanisms.evm.batch_settlement.client.storage import (
        BatchSettlementClientContext,
        InMemoryClientChannelStorage,
    )
    from x402.mechanisms.evm.batch_settlement.constants import (
        SCHEME_BATCH_SETTLEMENT,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
    from x402.mechanisms.evm.signers import EthAccountSigner
    from x402.schemas import PaymentRequired, PaymentRequirements, SettleResponse
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:84532"
RECEIVER = "0x3333333333333333333333333333333333333333"
RECEIVER_AUTHORIZER = "0x4444444444444444444444444444444444444444"
TOKEN = "0x5555555555555555555555555555555555555555"
TEST_PRIVATE_KEY = "0xa915e4eaadfaa5e6f59574d2c8e1d2a4cd2b6c0c0b9f6a3c7d9e2b8f5a4e3c2d"


def _signer() -> EthAccountSigner:
    return EthAccountSigner(Account.from_key(TEST_PRIVATE_KEY))


def _deps(storage: InMemoryClientChannelStorage | None = None) -> BatchSettlementClientDeps:
    return BatchSettlementClientDeps(
        signer=_signer(),
        storage=storage or InMemoryClientChannelStorage(),
        salt="0x" + "00" * 32,
    )


def _requirements() -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=NETWORK,
        asset=TOKEN,
        amount="0",
        pay_to=RECEIVER,
        max_timeout_seconds=60,
        extra={"receiverAuthorizer": RECEIVER_AUTHORIZER},
    )


def _payment_required() -> PaymentRequired:
    return PaymentRequired(x402_version=2, accepts=[_requirements()])


def _channel_id_for_signer(signer: EthAccountSigner) -> str:
    config = ChannelConfig(
        payer=signer.address,
        payer_authorizer=signer.address,
        receiver=RECEIVER,
        receiver_authorizer=RECEIVER_AUTHORIZER,
        token=TOKEN,
        withdraw_delay=900,
        salt="0x" + "00" * 32,
    )
    return compute_channel_id(config, NETWORK).lower()


class TestNormalizeRefundAmount:
    def test_none_passthrough(self):
        assert _normalize_refund_amount(None) is None

    def test_positive_integer_string(self):
        assert _normalize_refund_amount("100") == "100"

    def test_zero_rejected(self):
        with pytest.raises(ValueError):
            _normalize_refund_amount("0")

    def test_non_digit_rejected(self):
        with pytest.raises(ValueError):
            _normalize_refund_amount("abc")

    def test_negative_rejected(self):
        with pytest.raises(ValueError):
            _normalize_refund_amount("-5")

    def test_decimal_rejected(self):
        with pytest.raises(ValueError):
            _normalize_refund_amount("1.5")


class TestRefundResponseHeader:
    def test_header_case_insensitive(self):
        r = _RefundResponse(status=200, headers={"PAYMENT-RESPONSE": "x"})
        assert r.header("payment-response") == "x"
        assert r.header("PAYMENT-RESPONSE") == "x"

    def test_missing_returns_none(self):
        r = _RefundResponse(status=200, headers={})
        assert r.header("anything") is None


class _FakeFetch:
    def __init__(self, *responses: _RefundResponse) -> None:
        self._responses = list(responses)
        self.calls: list[tuple[str, dict[str, str]]] = []

    def __call__(self, url: str, headers: dict[str, str]) -> _RefundResponse:
        self.calls.append((url, headers))
        return self._responses.pop(0)


class TestRefundChannel:
    def test_happy_path(self):
        signer = _signer()
        deps = _deps()
        cid = _channel_id_for_signer(signer)
        deps.storage.set(cid, BatchSettlementClientContext(balance="500"))

        probe = _RefundResponse(
            status=402,
            headers={"PAYMENT-REQUIRED": encode_payment_required_header(_payment_required())},
        )
        success_settle = SettleResponse(
            success=True,
            transaction="0xref",
            network=NETWORK,
            extra={
                "channelState": {
                    "channelId": cid,
                    "balance": "0",
                    "totalClaimed": "0",
                }
            },
        )
        ok_response = _RefundResponse(
            status=200,
            headers={"PAYMENT-RESPONSE": encode_payment_response_header(success_settle)},
        )
        fetch = _FakeFetch(probe, ok_response)
        result = refund_channel(deps, "http://example/test", RefundOptions(fetch=fetch))
        assert result.success is True
        assert result.transaction == "0xref"
        # Sentinel kept (balance="0") so a subsequent refund fails locally.
        ctx = deps.storage.get(cid)
        assert ctx is not None
        assert ctx.balance == "0"
        assert len(fetch.calls) == 2

    def test_probe_non_402_raises(self):
        deps = _deps()
        fetch = _FakeFetch(_RefundResponse(status=200, headers={}))
        with pytest.raises(RuntimeError, match="expected 402"):
            refund_channel(deps, "http://x", RefundOptions(fetch=fetch))

    def test_probe_missing_required_header_raises(self):
        deps = _deps()
        fetch = _FakeFetch(_RefundResponse(status=402, headers={}))
        with pytest.raises(RuntimeError, match="PAYMENT-REQUIRED"):
            refund_channel(deps, "http://x", RefundOptions(fetch=fetch))

    def test_probe_without_batch_settlement_raises(self):
        deps = _deps()
        pr = PaymentRequired(
            x402_version=2,
            accepts=[
                PaymentRequirements(
                    scheme="exact",
                    network=NETWORK,
                    asset=TOKEN,
                    amount="100",
                    pay_to=RECEIVER,
                    max_timeout_seconds=60,
                    extra={},
                )
            ],
        )
        fetch = _FakeFetch(
            _RefundResponse(
                status=402,
                headers={"PAYMENT-REQUIRED": encode_payment_required_header(pr)},
            )
        )
        with pytest.raises(RuntimeError, match="batch-settlement"):
            refund_channel(deps, "http://x", RefundOptions(fetch=fetch))

    def test_probe_without_receiver_authorizer_raises(self):
        deps = _deps()
        req = PaymentRequirements(
            scheme=SCHEME_BATCH_SETTLEMENT,
            network=NETWORK,
            asset=TOKEN,
            amount="0",
            pay_to=RECEIVER,
            max_timeout_seconds=60,
            extra={},
        )
        pr = PaymentRequired(x402_version=2, accepts=[req])
        fetch = _FakeFetch(
            _RefundResponse(
                status=402,
                headers={"PAYMENT-REQUIRED": encode_payment_required_header(pr)},
            )
        )
        with pytest.raises(RuntimeError, match="receiverAuthorizer"):
            refund_channel(deps, "http://x", RefundOptions(fetch=fetch))

    def test_missing_local_channel_raises(self):
        deps = _deps()
        probe = _RefundResponse(
            status=402,
            headers={"PAYMENT-REQUIRED": encode_payment_required_header(_payment_required())},
        )
        fetch = _FakeFetch(probe)
        with pytest.raises(RuntimeError, match="existing channel"):
            refund_channel(deps, "http://x", RefundOptions(fetch=fetch))

    def test_zero_balance_raises(self):
        signer = _signer()
        deps = _deps()
        cid = _channel_id_for_signer(signer)
        deps.storage.set(
            cid,
            BatchSettlementClientContext(balance="100", charged_cumulative_amount="100"),
        )
        probe = _RefundResponse(
            status=402,
            headers={"PAYMENT-REQUIRED": encode_payment_required_header(_payment_required())},
        )
        fetch = _FakeFetch(probe)
        with pytest.raises(RuntimeError, match="no remaining balance"):
            refund_channel(deps, "http://x", RefundOptions(fetch=fetch))

    def test_settle_failure_in_response_raises(self):
        signer = _signer()
        deps = _deps()
        cid = _channel_id_for_signer(signer)
        deps.storage.set(cid, BatchSettlementClientContext(balance="500"))

        probe = _RefundResponse(
            status=402,
            headers={"PAYMENT-REQUIRED": encode_payment_required_header(_payment_required())},
        )
        failed_settle = SettleResponse(
            success=False,
            error_reason="invalid_refund",
            transaction="",
            network=NETWORK,
        )
        # status=402 + PAYMENT-RESPONSE present → non-recoverable failure path.
        fail_response = _RefundResponse(
            status=402,
            headers={
                "PAYMENT-RESPONSE": encode_payment_response_header(failed_settle),
            },
        )
        fetch = _FakeFetch(probe, fail_response)
        with pytest.raises(RuntimeError, match="Refund failed"):
            refund_channel(deps, "http://x", RefundOptions(fetch=fetch))
