"""Unit tests for server-side batch-settlement verify lifecycle hooks."""

from __future__ import annotations

import pytest

try:
    from x402.http.x402_http_server_base import x402HTTPServerBase
    from x402.mechanisms.evm.batch_settlement.constants import SCHEME_BATCH_SETTLEMENT
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_CHANNEL_BUSY,
        ERR_CUMULATIVE_AMOUNT_MISMATCH,
    )
    from x402.mechanisms.evm.batch_settlement.server.scheme import (
        BatchSettlementEvmScheme,
    )
    from x402.mechanisms.evm.batch_settlement.server.settle import handle_before_settle
    from x402.mechanisms.evm.batch_settlement.server.storage import (
        Channel,
        PendingRequest,
    )
    from x402.mechanisms.evm.batch_settlement.server.verify import (
        handle_after_verify,
        handle_before_verify,
        handle_enrich_payment_required_response,
        handle_verified_payment_canceled,
        handle_verify_failure,
    )
    from x402.mechanisms.evm.batch_settlement.types import ChannelConfig
    from x402.schemas import PaymentPayload, PaymentRequirements, VerifyResponse
    from x402.schemas.hooks import (
        AbortResult,
        SettleContext,
        SkipSettleResult,
        VerifyContext,
        VerifyResultContext,
    )
except ImportError:
    pytest.skip("batch_settlement requires evm extras", allow_module_level=True)


NETWORK = "eip155:8453"
RECEIVER = "0x3333333333333333333333333333333333333333"
USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
AUTHORIZER = "0x4444444444444444444444444444444444444444"
CHANNEL_ID = "0x" + "ab" * 32


def _channel_config() -> ChannelConfig:
    return ChannelConfig(
        payer="0x1111111111111111111111111111111111111111",
        payer_authorizer="0x2222222222222222222222222222222222222222",
        receiver=RECEIVER,
        receiver_authorizer=AUTHORIZER,
        token=USDC,
        withdraw_delay=900,
        salt="0x" + "00" * 31 + "01",
    )


def _voucher_payload(max_claimable: str = "100") -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={
            "type": "voucher",
            "channelConfig": _channel_config().to_dict(),
            "voucher": {
                "channelId": CHANNEL_ID,
                "maxClaimableAmount": max_claimable,
                "signature": "0x" + "11" * 65,
            },
        },
        accepted=PaymentRequirements(
            scheme=SCHEME_BATCH_SETTLEMENT,
            network=NETWORK,
            asset=USDC,
            amount="100",
            pay_to=RECEIVER,
            max_timeout_seconds=60,
            extra={},
        ),
    )


def _requirements(amount: str = "100") -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=NETWORK,
        asset=USDC,
        amount=amount,
        pay_to=RECEIVER,
        max_timeout_seconds=60,
        extra={},
    )


def _scheme() -> BatchSettlementEvmScheme:
    return BatchSettlementEvmScheme(RECEIVER)


def _seed_channel(scheme: BatchSettlementEvmScheme, **kwargs) -> Channel:
    defaults = {
        "channel_id": CHANNEL_ID,
        "channel_config": _channel_config(),
        "charged_cumulative_amount": "0",
        "signed_max_claimable": "0",
        "signature": "0x",
        "balance": "1000",
        "total_claimed": "0",
        "withdraw_requested_at": 0,
        "refund_nonce": 0,
        "last_request_timestamp": 0,
    }
    defaults.update(kwargs)
    ch = Channel(**defaults)
    scheme.get_storage().update_channel(CHANNEL_ID, lambda _current: ch)
    return ch


class TestHandleBeforeVerify:
    def test_non_batch_payload_returns_none(self):
        scheme = _scheme()
        payload = PaymentPayload(
            x402_version=2,
            payload={"type": "junk"},
            accepted=_requirements(),
        )
        ctx = VerifyContext(payment_payload=payload, requirements=_requirements())
        assert handle_before_verify(scheme, ctx) is None

    def test_first_voucher_reserves_provisional_channel(self):
        scheme = _scheme()
        ctx = VerifyContext(
            payment_payload=_voucher_payload(max_claimable="100"),
            requirements=_requirements(amount="100"),
        )
        out = handle_before_verify(scheme, ctx)
        assert out is None  # success path returns None
        # Provisional channel created in storage with pending reservation.
        ch = scheme.get_storage().get(CHANNEL_ID)
        assert ch is not None
        assert ch.pending_request is not None
        assert ch.pending_request.signed_max_claimable == "100"

    def test_cumulative_mismatch_aborts(self):
        scheme = _scheme()
        _seed_channel(scheme, charged_cumulative_amount="500")
        # signed cumulative 100 < expected 500 + 100
        ctx = VerifyContext(
            payment_payload=_voucher_payload(max_claimable="100"),
            requirements=_requirements(amount="100"),
        )
        out = handle_before_verify(scheme, ctx)
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_CUMULATIVE_AMOUNT_MISMATCH

    def test_busy_channel_aborts(self):
        scheme = _scheme()
        import time

        _seed_channel(
            scheme,
            charged_cumulative_amount="0",
            last_request_timestamp=int(time.time() * 1000),
        )

        def _add_pending(current):
            next_ch = current.copy()
            next_ch.pending_request = PendingRequest(
                pending_id="0xpending",
                signed_max_claimable="50",
                expires_at=int(time.time() * 1000) + 600_000,
            )
            return next_ch

        scheme.get_storage().update_channel(CHANNEL_ID, _add_pending)
        ctx = VerifyContext(
            payment_payload=_voucher_payload(max_claimable="100"),
            requirements=_requirements(amount="100"),
        )
        out = handle_before_verify(scheme, ctx)
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_CHANNEL_BUSY


class TestHandleAfterVerify:
    def test_failure_clears_pending(self):
        scheme = _scheme()
        # Seed an existing channel so the provisional snapshot path retains it on clear.
        _seed_channel(scheme, charged_cumulative_amount="0")
        ctx_before = VerifyContext(
            payment_payload=_voucher_payload(max_claimable="100"),
            requirements=_requirements(amount="100"),
        )
        handle_before_verify(scheme, ctx_before)
        assert scheme.get_storage().get(CHANNEL_ID).pending_request is not None

        invalid_result = VerifyResponse(is_valid=False, invalid_reason="bad")
        ctx_after = VerifyResultContext(
            payment_payload=ctx_before.payment_payload,
            requirements=_requirements(amount="100"),
            result=invalid_result,
        )
        handle_after_verify(scheme, ctx_after)
        ch = scheme.get_storage().get(CHANNEL_ID)
        assert ch is not None
        assert ch.pending_request is None


class TestHandleVerifyFailure:
    def test_clears_pending(self):
        scheme = _scheme()
        _seed_channel(scheme, charged_cumulative_amount="0")
        ctx_before = VerifyContext(
            payment_payload=_voucher_payload(),
            requirements=_requirements(),
        )
        handle_before_verify(scheme, ctx_before)
        assert scheme.get_storage().get(CHANNEL_ID).pending_request is not None

        class _FailureCtx:
            payment_payload = ctx_before.payment_payload

        handle_verify_failure(scheme, _FailureCtx())  # type: ignore[arg-type]
        ch = scheme.get_storage().get(CHANNEL_ID)
        assert ch is not None
        assert ch.pending_request is None


class TestHandleVerifiedPaymentCanceled:
    def test_handler_threw_clears(self):
        scheme = _scheme()
        _seed_channel(scheme, charged_cumulative_amount="0")
        ctx_before = VerifyContext(
            payment_payload=_voucher_payload(),
            requirements=_requirements(),
        )
        handle_before_verify(scheme, ctx_before)

        class _Ctx:
            reason = "handler_threw"
            payment_payload = ctx_before.payment_payload

        handle_verified_payment_canceled(scheme, _Ctx())  # type: ignore[arg-type]
        ch = scheme.get_storage().get(CHANNEL_ID)
        assert ch is not None
        assert ch.pending_request is None

    def test_other_reason_does_not_clear(self):
        scheme = _scheme()
        _seed_channel(scheme, charged_cumulative_amount="0")
        ctx_before = VerifyContext(
            payment_payload=_voucher_payload(),
            requirements=_requirements(),
        )
        handle_before_verify(scheme, ctx_before)

        class _Ctx:
            reason = "some_other_reason"
            payment_payload = ctx_before.payment_payload

        handle_verified_payment_canceled(scheme, _Ctx())  # type: ignore[arg-type]
        assert scheme.get_storage().get(CHANNEL_ID).pending_request is not None


class TestEnrichPaymentRequiredResponse:
    def test_non_cumulative_mismatch_passthrough(self):
        scheme = _scheme()

        class _Ctx:
            error = "some_other_error"
            payment_payload = _voucher_payload()
            requirements = [_requirements()]

        assert handle_enrich_payment_required_response(scheme, _Ctx()) is None  # type: ignore[arg-type]

    def test_mismatch_embeds_channel_state(self):
        scheme = _scheme()
        _seed_channel(
            scheme,
            charged_cumulative_amount="500",
            balance="2000",
            total_claimed="100",
            signed_max_claimable="500",
            signature="0xabcd",
        )

        class _Ctx:
            error = ERR_CUMULATIVE_AMOUNT_MISMATCH
            payment_payload = _voucher_payload()
            requirements = [_requirements()]

        out = handle_enrich_payment_required_response(scheme, _Ctx())  # type: ignore[arg-type]
        assert out is not None and len(out) == 1
        extra = out[0].extra or {}
        assert "channelState" in extra
        assert extra["channelState"]["balance"] == "2000"
        assert extra["channelState"]["chargedCumulativeAmount"] == "500"
        assert "voucherState" in extra
        assert extra["voucherState"]["signedMaxClaimable"] == "500"


class TestHandleBeforeSettle:
    def test_resolved_percent_override_increments_charged_total(self):
        scheme = _scheme()
        _seed_channel(scheme, charged_cumulative_amount="0", signed_max_claimable="10000")
        payload = _voucher_payload(max_claimable="10000")
        base_requirements = _requirements(amount="10000")
        resolved_amount = x402HTTPServerBase.resolve_settlement_override_amount(
            "7%", base_requirements
        )
        assert resolved_amount == "700"

        ctx_before = VerifyContext(payment_payload=payload, requirements=base_requirements)
        handle_before_verify(scheme, ctx_before)

        ctx = SettleContext(
            payment_payload=payload,
            requirements=base_requirements.model_copy(update={"amount": resolved_amount}),
        )
        out = handle_before_settle(scheme, ctx)
        assert isinstance(out, SkipSettleResult)
        ch = scheme.get_storage().get(CHANNEL_ID)
        assert ch is not None
        assert ch.charged_cumulative_amount == "700"
