"""Unit tests for server-side batch-settlement verify lifecycle hooks."""

from __future__ import annotations

import time

import pytest

try:
    from x402.http.x402_http_server_base import x402HTTPServerBase
    from x402.mechanisms.evm.batch_settlement.constants import SCHEME_BATCH_SETTLEMENT
    from x402.mechanisms.evm.batch_settlement.errors import (
        ERR_CHANNEL_BUSY,
        ERR_CHANNEL_ID_MISMATCH,
        ERR_CUMULATIVE_AMOUNT_MISMATCH,
        ERR_INVALID_CHANNEL_ID,
        ERR_VERIFICATION_STATE_UNAVAILABLE,
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
    from x402.mechanisms.evm.batch_settlement.utils import compute_channel_id
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


def _channel_id() -> str:
    return compute_channel_id(_channel_config(), NETWORK)


def _voucher_payload(
    max_claimable: str = "100",
    *,
    channel_id: str | None = None,
) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={
            "type": "voucher",
            "channelConfig": _channel_config().to_dict(),
            "voucher": {
                "channelId": channel_id or _channel_id(),
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
    channel_id = _channel_id()
    defaults = {
        "channel_id": channel_id,
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
    scheme.get_storage().update_channel(channel_id, lambda _current: ch)
    return ch


def _valid_verify_result() -> VerifyResponse:
    return VerifyResponse(
        is_valid=True,
        payer="0xpayer",
        extra={"balance": "1000", "totalClaimed": "0"},
    )


def _reserve(scheme: BatchSettlementEvmScheme, payload: PaymentPayload) -> None:
    ctx_before = VerifyContext(payment_payload=payload, requirements=_requirements())
    assert handle_before_verify(scheme, ctx_before) is None
    ctx_after = VerifyResultContext(
        payment_payload=payload,
        requirements=_requirements(),
        result=_valid_verify_result(),
    )
    assert handle_after_verify(scheme, ctx_after) is None


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

    def test_does_not_mutate_storage_on_match(self):
        scheme = _scheme()
        ctx = VerifyContext(
            payment_payload=_voucher_payload(max_claimable="100"),
            requirements=_requirements(amount="100"),
        )
        out = handle_before_verify(scheme, ctx)
        assert out is None
        assert scheme.get_storage().get(_channel_id()) is None
        request_ctx = scheme.read_request_context(ctx.payment_payload)
        assert request_ctx is not None
        assert request_ctx.pending_id is not None
        assert request_ctx.reservation_committed is False

    def test_non_canonical_channel_id_aborts_before_storage(self):
        scheme = _scheme()
        ctx = VerifyContext(
            payment_payload=_voucher_payload(channel_id="../../evil"),
            requirements=_requirements(),
        )
        out = handle_before_verify(scheme, ctx)
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_INVALID_CHANNEL_ID
        assert scheme.get_storage().list() == []

    def test_channel_id_mismatch_aborts(self):
        scheme = _scheme()
        ctx = VerifyContext(
            payment_payload=_voucher_payload(channel_id="0x" + "ab" * 32),
            requirements=_requirements(),
        )
        out = handle_before_verify(scheme, ctx)
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_CHANNEL_ID_MISMATCH

    def test_cumulative_mismatch_aborts(self):
        scheme = _scheme()
        _seed_channel(scheme, charged_cumulative_amount="500")
        ctx = VerifyContext(
            payment_payload=_voucher_payload(max_claimable="100"),
            requirements=_requirements(amount="100"),
        )
        out = handle_before_verify(scheme, ctx)
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_CUMULATIVE_AMOUNT_MISMATCH

    def test_busy_channel_does_not_abort_before_verify(self):
        """BeforeVerify is read-only — a live pending reservation must not abort here."""
        scheme = _scheme()
        _seed_channel(scheme, charged_cumulative_amount="0")

        def _add_pending(current):
            next_ch = current.copy()
            next_ch.pending_request = PendingRequest(
                pending_id="0xpending",
                signed_max_claimable="50",
                expires_at=int(time.time() * 1000) + 600_000,
            )
            return next_ch

        scheme.get_storage().update_channel(_channel_id(), _add_pending)
        ctx = VerifyContext(
            payment_payload=_voucher_payload(max_claimable="100"),
            requirements=_requirements(amount="100"),
        )
        out = handle_before_verify(scheme, ctx)
        assert out is None


class TestHandleAfterVerify:
    def test_reserves_after_valid_verify(self):
        scheme = _scheme()
        payload = _voucher_payload(max_claimable="100")
        ctx_before = VerifyContext(
            payment_payload=payload,
            requirements=_requirements(amount="100"),
        )
        handle_before_verify(scheme, ctx_before)
        assert scheme.get_storage().get(_channel_id()) is None

        ctx_after = VerifyResultContext(
            payment_payload=payload,
            requirements=_requirements(amount="100"),
            result=_valid_verify_result(),
        )
        out = handle_after_verify(scheme, ctx_after)
        assert out is None
        ch = scheme.get_storage().get(_channel_id())
        assert ch is not None
        assert ch.pending_request is not None
        assert scheme.read_request_context(payload).reservation_committed is True

    def test_invalid_result_does_not_create_channel(self):
        scheme = _scheme()
        payload = _voucher_payload(max_claimable="100")
        handle_before_verify(
            scheme,
            VerifyContext(payment_payload=payload, requirements=_requirements()),
        )
        handle_after_verify(
            scheme,
            VerifyResultContext(
                payment_payload=payload,
                requirements=_requirements(),
                result=VerifyResponse(is_valid=False, invalid_reason="bad"),
            ),
        )
        assert scheme.get_storage().get(_channel_id()) is None

    def test_busy_channel_aborts(self):
        scheme = _scheme()
        _seed_channel(scheme, charged_cumulative_amount="0")

        def _add_pending(current):
            next_ch = current.copy()
            next_ch.pending_request = PendingRequest(
                pending_id="0xpending",
                signed_max_claimable="50",
                expires_at=int(time.time() * 1000) + 600_000,
            )
            return next_ch

        scheme.get_storage().update_channel(_channel_id(), _add_pending)
        payload = _voucher_payload(max_claimable="100")
        handle_before_verify(
            scheme,
            VerifyContext(payment_payload=payload, requirements=_requirements()),
        )
        out = handle_after_verify(
            scheme,
            VerifyResultContext(
                payment_payload=payload,
                requirements=_requirements(),
                result=_valid_verify_result(),
            ),
        )
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_CHANNEL_BUSY

    def test_missing_request_context_aborts(self):
        scheme = _scheme()
        payload = _voucher_payload()
        out = handle_after_verify(
            scheme,
            VerifyResultContext(
                payment_payload=payload,
                requirements=_requirements(),
                result=_valid_verify_result(),
            ),
        )
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_VERIFICATION_STATE_UNAVAILABLE


class TestHandleVerifyFailure:
    def test_does_not_clear_before_reservation_committed(self):
        scheme = _scheme()
        payload = _voucher_payload()
        handle_before_verify(
            scheme,
            VerifyContext(payment_payload=payload, requirements=_requirements()),
        )

        class _FailureCtx:
            payment_payload = payload

        handle_verify_failure(scheme, _FailureCtx())  # type: ignore[arg-type]
        # No committed reservation existed, so storage stays empty.
        assert scheme.get_storage().get(_channel_id()) is None


class TestHandleVerifiedPaymentCanceled:
    def test_handler_threw_clears_committed_reservation(self):
        scheme = _scheme()
        payload = _voucher_payload()
        _reserve(scheme, payload)
        assert scheme.get_storage().get(_channel_id()).pending_request is not None

        class _Ctx:
            reason = "handler_threw"
            payment_payload = payload

        handle_verified_payment_canceled(scheme, _Ctx())  # type: ignore[arg-type]
        ch = scheme.get_storage().get(_channel_id())
        assert ch is not None
        assert ch.pending_request is None

    def test_after_verify_aborted_clears_committed_reservation(self):
        scheme = _scheme()
        payload = _voucher_payload()
        _reserve(scheme, payload)

        class _Ctx:
            reason = "after_verify_aborted"
            payment_payload = payload

        handle_verified_payment_canceled(scheme, _Ctx())  # type: ignore[arg-type]
        assert scheme.get_storage().get(_channel_id()).pending_request is None

    def test_other_reason_does_not_clear(self):
        scheme = _scheme()
        payload = _voucher_payload()
        _reserve(scheme, payload)

        class _Ctx:
            reason = "some_other_reason"
            payment_payload = payload

        handle_verified_payment_canceled(scheme, _Ctx())  # type: ignore[arg-type]
        assert scheme.get_storage().get(_channel_id()).pending_request is not None


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
        assert handle_before_verify(scheme, ctx_before) is None
        assert (
            handle_after_verify(
                scheme,
                VerifyResultContext(
                    payment_payload=payload,
                    requirements=base_requirements,
                    result=_valid_verify_result(),
                ),
            )
            is None
        )

        ctx = SettleContext(
            payment_payload=payload,
            requirements=base_requirements.model_copy(update={"amount": resolved_amount}),
        )
        out = handle_before_settle(scheme, ctx)
        assert isinstance(out, SkipSettleResult)
        ch = scheme.get_storage().get(_channel_id())
        assert ch is not None
        assert ch.charged_cumulative_amount == "700"
