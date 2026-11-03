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
        ERR_DEPOSIT_BELOW_MIN_DEPOSIT,
        ERR_INVALID_CHANNEL_ID,
        ERR_MISSING_CHANNEL,
        ERR_VERIFICATION_STATE_UNAVAILABLE,
        ERR_VOUCHER_STORE_UNAVAILABLE,
    )
    from x402.mechanisms.evm.batch_settlement.server.scheme import (
        BatchSettlementEvmScheme,
        BatchSettlementEvmSchemeServerConfig,
        BatchSettlementRequestContext,
    )
    from x402.mechanisms.evm.batch_settlement.server.settle import (
        handle_after_settle,
        handle_before_settle,
    )
    from x402.mechanisms.evm.batch_settlement.server.storage import (
        Channel,
        ChannelUpdateResult,
        InMemoryChannelStorage,
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
    from x402.schemas import (
        AfterSettleAbortError,
        PaymentPayload,
        PaymentRequirements,
        SettleResponse,
        VerifyResponse,
    )
    from x402.schemas.hooks import (
        AbortResult,
        SettleContext,
        SettleResultContext,
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


def _deposit_payload(
    deposit_amount: str,
    max_claimable: str = "1000",
    *,
    channel_id: str | None = None,
) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={
            "type": "deposit",
            "channelConfig": _channel_config().to_dict(),
            "voucher": {
                "channelId": channel_id or _channel_id(),
                "maxClaimableAmount": max_claimable,
                "signature": "0x" + "11" * 65,
            },
            "deposit": {
                "amount": deposit_amount,
                "authorization": {},
            },
        },
        accepted=_requirements(amount=max_claimable),
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

    def test_does_not_reject_deposits_below_min_deposit_when_enforcement_is_disabled(self):
        scheme = _scheme()
        requirements = PaymentRequirements(
            scheme=SCHEME_BATCH_SETTLEMENT,
            network=NETWORK,
            asset=USDC,
            amount="1000",
            pay_to=RECEIVER,
            max_timeout_seconds=60,
            extra={"receiverAuthorizer": AUTHORIZER, "minDeposit": "10000"},
        )
        result = handle_before_verify(
            scheme,
            VerifyContext(
                payment_payload=_deposit_payload("5000", "1000"),
                requirements=requirements,
            ),
        )
        assert result is None

    def test_rejects_deposits_below_min_deposit_when_enforcement_is_enabled(self):
        enforcing_server = BatchSettlementEvmScheme(
            RECEIVER, BatchSettlementEvmSchemeServerConfig(enforce_min_deposit=True)
        )
        requirements = PaymentRequirements(
            scheme=SCHEME_BATCH_SETTLEMENT,
            network=NETWORK,
            asset=USDC,
            amount="1000",
            pay_to=RECEIVER,
            max_timeout_seconds=60,
            extra={"receiverAuthorizer": AUTHORIZER, "minDeposit": "10000"},
        )

        below_min = handle_before_verify(
            enforcing_server,
            VerifyContext(
                payment_payload=_deposit_payload("5000", "1000"),
                requirements=requirements,
            ),
        )
        assert isinstance(below_min, AbortResult)
        assert below_min.reason == ERR_DEPOSIT_BELOW_MIN_DEPOSIT

        at_min = handle_before_verify(
            enforcing_server,
            VerifyContext(
                payment_payload=_deposit_payload("10000", "1000"),
                requirements=requirements,
            ),
        )
        assert at_min is None

    def test_enforces_the_default_10x_min_deposit_hint_when_extra_min_deposit_is_omitted(self):
        enforcing_server = BatchSettlementEvmScheme(
            RECEIVER, BatchSettlementEvmSchemeServerConfig(enforce_min_deposit=True)
        )
        requirements = _requirements(amount="1000")
        below_default = handle_before_verify(
            enforcing_server,
            VerifyContext(
                payment_payload=_deposit_payload("5000", "1000"),
                requirements=requirements,
            ),
        )
        assert isinstance(below_default, AbortResult)
        assert below_default.reason == ERR_DEPOSIT_BELOW_MIN_DEPOSIT


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
        assert ch.charged_cumulative_amount == "0"
        assert scheme.read_request_context(payload).reservation_committed is True

    def _after_verify_no_record(self, max_claimable: str, extra: dict, *, deposit: bool = False):
        scheme = _scheme()
        payload = (
            _deposit_payload("500", max_claimable)
            if deposit
            else _voucher_payload(max_claimable=max_claimable)
        )
        requirements = _requirements(amount="100")
        assert (
            handle_before_verify(
                scheme, VerifyContext(payment_payload=payload, requirements=requirements)
            )
            is None
        )
        out = handle_after_verify(
            scheme,
            VerifyResultContext(
                payment_payload=payload,
                requirements=requirements,
                result=VerifyResponse(is_valid=True, payer="0xpayer", extra=extra),
            ),
        )
        return scheme, payload, out

    def test_no_record_baseline_is_onchain_total_claimed(self):
        scheme, _, out = self._after_verify_no_record(
            "1100", {"balance": "5000", "totalClaimed": "1000"}
        )
        assert out is None
        ch = scheme.get_storage().get(_channel_id())
        assert ch is not None
        assert ch.charged_cumulative_amount == "1000"
        assert ch.total_claimed == "1000"

    def test_no_record_shortfall_voucher_aborts_with_onchain_baseline_snapshot(self):
        scheme, payload, out = self._after_verify_no_record(
            "1001", {"balance": "5000", "totalClaimed": "1000", "refundNonce": 2}
        )
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_CUMULATIVE_AMOUNT_MISMATCH
        assert scheme.get_storage().get(_channel_id()) is None
        snapshot = scheme.read_request_context(payload).channel_snapshot
        assert snapshot is not None
        assert snapshot.charged_cumulative_amount == "1000"
        assert snapshot.balance == "5000"
        assert snapshot.total_claimed == "1000"
        assert snapshot.refund_nonce == 2

    def test_no_record_shortfall_deposit_aborts(self):
        _, _, out = self._after_verify_no_record(
            "1001", {"balance": "5000", "totalClaimed": "1000"}, deposit=True
        )
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_CUMULATIVE_AMOUNT_MISMATCH

    @pytest.mark.parametrize(
        "extra",
        [
            {"balance": "5000"},
            {"balance": "5000", "totalClaimed": None},
            {"balance": "5000", "totalClaimed": "abc"},
            {"balance": "5000", "totalClaimed": "-1"},
            {"balance": "5000", "totalClaimed": True},
        ],
    )
    def test_no_record_missing_or_invalid_total_claimed_fails_closed(self, extra):
        scheme, _, out = self._after_verify_no_record("1100", extra)
        assert isinstance(out, AbortResult)
        assert out.reason == ERR_VERIFICATION_STATE_UNAVAILABLE
        assert scheme.get_storage().get(_channel_id()) is None

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


class _FaultyStorage(InMemoryChannelStorage):
    """In-memory storage whose update_channel fails or returns a forced result."""

    def __init__(
        self,
        update_error: Exception | None = None,
        force_result: ChannelUpdateResult | None = None,
    ) -> None:
        super().__init__()
        self.update_error = update_error
        self.force_result = force_result

    def update_channel(self, channel_id, update):
        if self.update_error is not None:
            raise self.update_error
        if self.force_result is not None:
            return self.force_result
        return super().update_channel(channel_id, update)


def _deposit_after_settle_ctx(payload: PaymentPayload) -> SettleResultContext:
    return SettleResultContext(
        payment_payload=payload,
        requirements=_requirements(amount="1000"),
        result=SettleResponse(
            success=True,
            transaction="0xdeposit",
            network=NETWORK,
            payer="0xpayer",
            extra={
                "channelState": {
                    "channelId": _channel_id(),
                    "balance": "10000",
                    "totalClaimed": "0",
                    "withdrawRequestedAt": 0,
                    "refundNonce": "0",
                }
            },
        ),
    )


def _reserved_deposit_scheme(storage: InMemoryChannelStorage):
    scheme = BatchSettlementEvmScheme(
        RECEIVER, BatchSettlementEvmSchemeServerConfig(storage=storage)
    )
    _seed_channel(
        scheme,
        charged_cumulative_amount="0",
        pending_request=PendingRequest(
            pending_id="p-deposit",
            signed_max_claimable="1000",
            expires_at=int(time.time() * 1000) + 600_000,
        ),
    )
    payload = _deposit_payload("5000", "1000")
    scheme.merge_request_context(
        payload,
        BatchSettlementRequestContext(
            channel_id=_channel_id(),
            pending_id="p-deposit",
            reservation_committed=True,
        ),
    )
    return scheme, payload


class TestHandleAfterSettleDeposit:
    def test_persist_error_aborts_voucher_store_unavailable(self):
        storage = _FaultyStorage()
        scheme, payload = _reserved_deposit_scheme(storage)
        storage.update_error = RuntimeError("storage write failed")

        with pytest.raises(AfterSettleAbortError) as exc:
            handle_after_settle(scheme, _deposit_after_settle_ctx(payload))

        assert exc.value.reason == ERR_VOUCHER_STORE_UNAVAILABLE
        assert exc.value.message == "storage write failed"

    @pytest.mark.parametrize(
        "forced",
        [
            ChannelUpdateResult(channel=None, status="deleted"),
            ChannelUpdateResult(channel=None, status="unchanged"),
            ChannelUpdateResult(channel=None, status="updated"),
        ],
        ids=["deleted", "unchanged", "updated_without_row"],
    )
    def test_persist_status_without_updated_channel_aborts_busy(self, forced):
        storage = _FaultyStorage()
        scheme, payload = _reserved_deposit_scheme(storage)
        storage.force_result = forced

        with pytest.raises(AfterSettleAbortError) as exc:
            handle_after_settle(scheme, _deposit_after_settle_ctx(payload))

        assert exc.value.reason == ERR_CHANNEL_BUSY

    def test_missing_channel_row_aborts_missing_channel(self):
        storage = InMemoryChannelStorage()
        scheme, payload = _reserved_deposit_scheme(storage)
        storage.update_channel(_channel_id(), lambda _current: None)

        with pytest.raises(AfterSettleAbortError) as exc:
            handle_after_settle(scheme, _deposit_after_settle_ctx(payload))

        assert exc.value.reason == ERR_MISSING_CHANNEL

    def test_persist_updates_channel_without_abort(self):
        storage = InMemoryChannelStorage()
        scheme, payload = _reserved_deposit_scheme(storage)

        handle_after_settle(scheme, _deposit_after_settle_ctx(payload))

        channel = storage.get(_channel_id())
        assert channel is not None
        assert channel.charged_cumulative_amount == "1000"
        assert channel.pending_request is None
