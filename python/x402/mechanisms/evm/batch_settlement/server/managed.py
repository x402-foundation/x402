"""Pass-through server hooks for facilitator-owned EVM vouchers."""

from __future__ import annotations

import logging
import time
from typing import TYPE_CHECKING, Any

from .....schemas import AfterSettleAbortError, PaymentPayload, PaymentRequirements, VerifyResponse
from .....schemas.hooks import (
    AbortResult,
    SettleContext,
    SettleResultContext,
    SkipHandlerDirective,
    SkipHandlerResult,
    VerifiedPaymentCanceledContext,
    VerifyContext,
    VerifyFailureContext,
    VerifyResultContext,
)
from ..authorizer_signer import sign_refund
from ..errors import (
    ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED,
    ERR_CUMULATIVE_AMOUNT_MISMATCH,
    ERR_DEPOSIT_BELOW_MIN_DEPOSIT,
    ERR_MISSING_CHANNEL,
    ERR_REFUND_AMOUNT_INVALID,
    ERR_REFUND_NO_BALANCE,
    ERR_UNEXPECTED_CANCEL,
    ERR_UNEXPECTED_PENDING_ID,
    ERR_VERIFICATION_STATE_UNAVAILABLE,
    ERR_VOUCHER_STORE_MODE_MISMATCH,
    ERR_VOUCHER_STORE_UNAVAILABLE,
)
from ..types import (
    ChannelConfig,
    ChannelStateExtra,
    VoucherClaim,
    VoucherStateExtra,
    is_deposit_payload,
    is_refund_payload,
    is_voucher_payload,
)
from ..utils import channel_id_binding_error
from .storage import Channel
from .verify import _read_required_uint_extra

if TYPE_CHECKING:
    from .....interfaces import SchemePaymentRequiredContext
    from .scheme import BatchSettlementEvmScheme

logger = logging.getLogger(__name__)
_CORRECTIVE_REASONS = {ERR_CUMULATIVE_AMOUNT_MISMATCH, ERR_CUMULATIVE_AMOUNT_BELOW_CLAIMED}


def _is_batched(raw: dict[str, Any]) -> bool:
    return is_deposit_payload(raw) or is_voucher_payload(raw) or is_refund_payload(raw)


def mode_mismatch(
    scheme: BatchSettlementEvmScheme, ctx: VerifyContext | SettleContext
) -> AbortResult | None:
    mode = (ctx.requirements.extra or {}).get("voucherManager", "server")
    expected = "facilitator" if scheme.is_facilitator_managed() else "server"
    if mode != expected:
        return AbortResult(reason=ERR_VOUCHER_STORE_MODE_MISMATCH)
    return None


def handle_before_verify(
    scheme: BatchSettlementEvmScheme, ctx: VerifyContext
) -> AbortResult | None:
    raw = ctx.payment_payload.payload
    if not _is_batched(raw):
        return None
    if "pendingId" in raw:
        return AbortResult(reason=ERR_UNEXPECTED_PENDING_ID)
    if "cancel" in raw:
        return AbortResult(reason=ERR_UNEXPECTED_CANCEL)
    if scheme.get_enforce_min_deposit() and is_deposit_payload(raw):
        if int(raw["deposit"]["amount"]) < int(scheme.resolve_min_deposit_hint(ctx.requirements)):
            return AbortResult(reason=ERR_DEPOSIT_BELOW_MIN_DEPOSIT)
    error = channel_id_binding_error(
        ChannelConfig.from_dict(raw["channelConfig"]),
        raw["voucher"]["channelId"],
        ctx.requirements.network,
    )
    return AbortResult(reason=error) if error else None


def _remember_corrective(
    scheme: BatchSettlementEvmScheme, payload: PaymentPayload, result: VerifyResponse
) -> None:
    from .scheme import BatchSettlementRequestContext

    if result.invalid_reason not in _CORRECTIVE_REASONS:
        return
    extra = result.extra or {}
    channel_state, voucher_state = extra.get("channelState"), extra.get("voucherState")
    if not isinstance(channel_state, dict) or not isinstance(voucher_state, dict):
        return
    try:
        channel = ChannelStateExtra.from_dict(channel_state)
        voucher = VoucherStateExtra.from_dict(voucher_state)
    except (KeyError, TypeError, ValueError):
        return
    scheme.merge_request_context(
        payload,
        BatchSettlementRequestContext(
            corrective_channel_state=channel, corrective_voucher_state=voucher
        ),
    )


def handle_after_verify(
    scheme: BatchSettlementEvmScheme, ctx: VerifyResultContext
) -> AbortResult | SkipHandlerResult | None:
    from .scheme import BatchSettlementRequestContext

    raw = ctx.payment_payload.payload
    if not _is_batched(raw):
        return None
    if not ctx.result.is_valid:
        _remember_corrective(scheme, ctx.payment_payload, ctx.result)
        return None
    extra = ctx.result.extra or {}
    voucher = raw["voucher"]
    pending_id = extra.get("pendingId")
    # Remember trusted admission before validating the snapshot so an abort can release it.
    scheme.merge_request_context(
        ctx.payment_payload,
        BatchSettlementRequestContext(
            channel_id=voucher["channelId"],
            pending_id=pending_id if isinstance(pending_id, str) and pending_id else None,
        ),
    )
    charged = _read_required_uint_extra(extra, "chargedCumulativeAmount")
    balance = _read_required_uint_extra(extra, "balance")
    total_claimed = _read_required_uint_extra(extra, "totalClaimed")
    refund_nonce = _read_required_uint_extra(extra, "refundNonce")
    withdraw_requested_at = _read_required_uint_extra(extra, "withdrawRequestedAt")
    if (
        not isinstance(pending_id, str)
        or not pending_id
        or charged is None
        or balance is None
        or total_claimed is None
        or refund_nonce is None
        or withdraw_requested_at is None
    ):
        return AbortResult(reason=ERR_VERIFICATION_STATE_UNAVAILABLE)
    snapshot = Channel(
        channel_id=voucher["channelId"],
        channel_config=ChannelConfig.from_dict(raw["channelConfig"]),
        charged_cumulative_amount=charged,
        signed_max_claimable=voucher["maxClaimableAmount"],
        signature=voucher["signature"],
        balance=balance,
        total_claimed=total_claimed,
        withdraw_requested_at=int(withdraw_requested_at),
        refund_nonce=int(refund_nonce),
        last_request_timestamp=int(time.time() * 1000),
    )
    scheme.merge_request_context(
        ctx.payment_payload,
        BatchSettlementRequestContext(channel_snapshot=snapshot),
    )
    if is_refund_payload(raw):
        return SkipHandlerResult(
            response=SkipHandlerDirective(
                content_type="application/json",
                body={"refunded": True, "channelId": snapshot.channel_id},
            )
        )
    return None


def handle_enrich_payment_required_response(
    scheme: BatchSettlementEvmScheme, ctx: SchemePaymentRequiredContext
) -> list[PaymentRequirements] | None:
    if ctx.error not in _CORRECTIVE_REASONS or ctx.payment_payload is None:
        return None
    request = scheme.take_request_context(ctx.payment_payload)
    if (
        request is None
        or request.corrective_channel_state is None
        or request.corrective_voucher_state is None
    ):
        return None
    accepted = ctx.payment_payload.accepted
    for requirement in ctx.requirements:
        if requirement.scheme == accepted.scheme and requirement.network == accepted.network:
            requirement.extra = {
                **(requirement.extra or {}),
                "channelState": request.corrective_channel_state.to_dict(),
                "voucherState": request.corrective_voucher_state.to_dict(),
            }
    return ctx.requirements


def handle_before_settle(scheme: BatchSettlementEvmScheme, ctx: SettleContext) -> None:
    return None


def handle_verified_payment_canceled(
    scheme: BatchSettlementEvmScheme, ctx: VerifiedPaymentCanceledContext
) -> None:
    # Manual after-verify hooks can abort before the scheme captured admission.
    request = scheme.read_request_context(ctx.payment_payload)
    result = ctx.verify_result
    if (request is None or not request.pending_id) and result is not None and result.is_valid:
        pending_id = (result.extra or {}).get("pendingId")
        if isinstance(pending_id, str) and pending_id:
            from .scheme import BatchSettlementRequestContext

            scheme.merge_request_context(
                ctx.payment_payload, BatchSettlementRequestContext(pending_id=pending_id)
            )


def handle_settle_on_cancel(ctx: VerifiedPaymentCanceledContext) -> PaymentRequirements | None:
    if ctx.reason not in (
        "handler_failed",
        "handler_threw",
        "after_verify_aborted",
        "settlement_failed",
    ):
        return None
    if not _is_batched(ctx.payment_payload.payload):
        return None
    return ctx.requirements.model_copy(update={"amount": "0"})


def handle_enrich_settlement_payload(
    scheme: BatchSettlementEvmScheme, ctx: SettleContext
) -> dict[str, object] | None:
    raw = ctx.payment_payload.payload
    if not _is_batched(raw):
        return None
    request = scheme.read_request_context(ctx.payment_payload)
    fields: dict[str, object] = {}
    if request is not None and request.pending_id:
        fields["pendingId"] = request.pending_id
    if ctx.phase == "cancel":
        return {**fields, "cancel": True}
    if not is_refund_payload(raw):
        return fields or None
    if request is None or request.channel_snapshot is None:
        raise ValueError(ERR_MISSING_CHANNEL)
    snapshot = request.channel_snapshot
    amount = int(snapshot.balance) - int(snapshot.charged_cumulative_amount)
    if amount <= 0:
        raise ValueError(ERR_REFUND_NO_BALANCE)
    requested = raw.get("amount")
    if requested is not None:
        if (
            not isinstance(requested, str)
            or not requested.isascii()
            or not requested.isdecimal()
            or int(requested) <= 0
        ):
            raise ValueError(ERR_REFUND_AMOUNT_INVALID)
        if int(requested) > amount:
            raise ValueError(ERR_REFUND_NO_BALANCE)
        amount = int(requested)
    claim = VoucherClaim(
        channel=snapshot.channel_config,
        max_claimable_amount=raw["voucher"]["maxClaimableAmount"],
        signature=raw["voucher"]["signature"],
        total_claimed=snapshot.charged_cumulative_amount,
    )
    fields.update({"refundNonce": str(snapshot.refund_nonce), "claims": [claim.to_dict()]})
    if requested is None:
        fields["amount"] = str(amount)
    signer = scheme.get_refund_authorizer_signer()
    if signer is not None:
        fields["refundAuthorizerSignature"] = sign_refund(
            signer,
            snapshot.channel_id,
            str(amount),
            str(snapshot.refund_nonce),
            str(ctx.requirements.network),
        )
    return fields


def handle_after_settle(scheme: BatchSettlementEvmScheme, ctx: SettleResultContext) -> None:
    if not ctx.result.success:
        return
    try:
        if ctx.phase == "cancel" or not _is_batched(ctx.payment_payload.payload):
            return
        raw = ctx.payment_payload.payload
        state = (ctx.result.extra or {}).get("channelState")
        if not isinstance(state, dict):
            raise AfterSettleAbortError(
                ERR_VOUCHER_STORE_UNAVAILABLE, "Missing managed channel snapshot"
            )
        charged = _read_required_uint_extra(state, "chargedCumulativeAmount")
        balance = _read_required_uint_extra(state, "balance")
        total_claimed = _read_required_uint_extra(state, "totalClaimed")
        refund_nonce = _read_required_uint_extra(state, "refundNonce")
        withdraw_requested_at = _read_required_uint_extra(state, "withdrawRequestedAt")
        if (
            charged is None
            or balance is None
            or total_claimed is None
            or refund_nonce is None
            or withdraw_requested_at is None
        ):
            raise AfterSettleAbortError(
                ERR_VOUCHER_STORE_UNAVAILABLE, "Invalid managed channel snapshot"
            )

        def update(current: Channel | None) -> Channel | None:
            if is_refund_payload(raw) and int(balance) <= int(charged):
                return None
            if current is not None and int(charged) < int(current.charged_cumulative_amount):
                return current
            replica = Channel(
                channel_id=raw["voucher"]["channelId"],
                channel_config=ChannelConfig.from_dict(raw["channelConfig"]),
                charged_cumulative_amount=charged,
                signed_max_claimable=raw["voucher"]["maxClaimableAmount"],
                signature=raw["voucher"]["signature"],
                balance=balance,
                total_claimed=total_claimed,
                withdraw_requested_at=int(withdraw_requested_at),
                refund_nonce=int(refund_nonce),
                last_request_timestamp=int(time.time() * 1000),
            )
            return replica

        try:
            scheme.get_storage().update_channel(raw["voucher"]["channelId"], update)
        except Exception:
            # A replica is observational: its failure cannot undo the remote charge.
            logger.exception(
                "Failed to update managed batch-settlement replica for %s",
                raw["voucher"]["channelId"],
            )
    finally:
        scheme.take_request_context(ctx.payment_payload)


def handle_verify_failure(scheme: BatchSettlementEvmScheme, ctx: VerifyFailureContext) -> None:
    scheme.take_request_context(ctx.payment_payload)


def handle_enrich_settlement_response(
    scheme: BatchSettlementEvmScheme, ctx: SettleResultContext
) -> None:
    return None
