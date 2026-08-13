"""Server-side settle lifecycle hooks for the batch-settlement EVM scheme."""

from __future__ import annotations

import re
import time
from typing import TYPE_CHECKING, Any

from ..authorizer_signer import sign_claim_batch, sign_refund
from ..errors import (
    ERR_CHANNEL_BUSY,
    ERR_CHARGE_EXCEEDS_SIGNED_CUMULATIVE,
    ERR_CUMULATIVE_AMOUNT_MISMATCH,
    ERR_INVALID_VOUCHER_SIGNATURE,
    ERR_MISSING_CHANNEL,
    ERR_REFUND_AMOUNT_INVALID,
    ERR_REFUND_NO_BALANCE,
)
from ..types import (
    VoucherClaim,
    is_deposit_payload,
    is_refund_payload,
    is_voucher_payload,
)
from ..utils import compute_channel_id
from .storage import Channel
from .utils import (
    parse_refund_settlement_snapshot,
    read_channel_state_extra,
    read_extra_number,
    read_extra_string,
)

if TYPE_CHECKING:
    from .....schemas.hooks import (
        SettleContext,
        SettleFailureContext,
        SettleResultContext,
    )
    from .scheme import BatchSettlementEvmScheme


_UINT_RE = re.compile(r"^\d+$")


def _now_ms() -> int:
    return int(time.time() * 1000)


def _channel_state_extra(
    channel: Channel, charged_cumulative_amount: str | None = None
) -> dict[str, Any]:
    out: dict[str, Any] = {
        "channelId": channel.channel_id,
        "balance": channel.balance,
        "totalClaimed": channel.total_claimed,
        "withdrawRequestedAt": channel.withdraw_requested_at,
        "refundNonce": str(channel.refund_nonce),
    }
    if charged_cumulative_amount is not None:
        out["chargedCumulativeAmount"] = charged_cumulative_amount
    return out


def handle_before_settle(scheme: BatchSettlementEvmScheme, ctx: SettleContext):
    """For voucher payloads: short-circuit settle by incrementing local charged total.

    Cooperative refund and deposit payloads fall through to the facilitator.
    """
    from .....schemas import SettleResponse
    from .....schemas.hooks import AbortResult, SkipSettleResult

    payment_payload = ctx.payment_payload
    requirements = ctx.requirements
    raw = payment_payload.payload

    if not is_voucher_payload(raw):
        return None

    voucher = raw["voucher"]
    channel_id = voucher["channelId"]
    pending_id = None
    request_context = scheme.read_request_context(payment_payload)
    if request_context is not None:
        pending_id = request_context.pending_id

    increment = int(requirements.amount)
    signed_cap = int(voucher["maxClaimableAmount"])
    outcome: dict[str, Any] = {}

    def update(current: Channel | None) -> Channel | None:
        if current is None:
            outcome["status"] = "missing"
            return current
        if not pending_id or (
            current.pending_request is None or current.pending_request.pending_id != pending_id
        ):
            outcome["status"] = "pending_mismatch"
            return current

        new_charged = int(current.charged_cumulative_amount) + increment
        if new_charged > signed_cap:
            outcome["status"] = "cap_exceeded"
            outcome["charged"] = str(new_charged)
            next_ch = current.copy()
            next_ch.pending_request = None
            return next_ch

        next_ch = current.copy()
        next_ch.charged_cumulative_amount = str(new_charged)
        next_ch.signed_max_claimable = str(voucher["maxClaimableAmount"])
        next_ch.signature = voucher.get("signature", current.signature)
        next_ch.last_request_timestamp = _now_ms()
        next_ch.pending_request = None
        outcome["status"] = "committed"
        outcome["previous"] = current
        outcome["current"] = next_ch
        return next_ch

    update_result = scheme.get_storage().update_channel(channel_id, update)

    status = outcome.get("status")
    if status == "missing":
        scheme.take_request_context(payment_payload)
        return AbortResult(reason=ERR_MISSING_CHANNEL)

    if status == "cap_exceeded":
        scheme.take_request_context(payment_payload)
        return AbortResult(reason=ERR_CHARGE_EXCEEDS_SIGNED_CUMULATIVE)

    if update_result.status != "updated" or status != "committed":
        scheme.take_request_context(payment_payload)
        return AbortResult(reason=ERR_CHANNEL_BUSY)

    scheme.take_request_context(payment_payload)

    previous: Channel = outcome["previous"]
    current_ch: Channel = outcome["current"]
    skip_extra: dict[str, Any] = {
        "channelState": _channel_state_extra(previous, current_ch.charged_cumulative_amount),
        "chargedAmount": requirements.amount,
    }
    response = SettleResponse(
        success=True,
        payer=previous.channel_config.payer.lower(),
        transaction="",
        network=requirements.network,
        amount="",
        extra=skip_extra,
    )
    return SkipSettleResult(result=response)


def handle_enrich_settlement_payload(
    scheme: BatchSettlementEvmScheme, ctx: SettleContext
) -> dict[str, Any] | None:
    """For cooperative refund payloads: attach refund + claim batch + authorizer sigs."""
    payment_payload = ctx.payment_payload
    requirements = ctx.requirements
    raw = payment_payload.payload
    if not is_refund_payload(raw):
        return None

    network = str(requirements.network)
    from ..types import ChannelConfig

    channel_config = ChannelConfig.from_dict(raw["channelConfig"])
    channel_id = compute_channel_id(channel_config, network)
    if raw["voucher"]["channelId"] != channel_id:
        raise ValueError("refund channelId does not match channelConfig")

    channel = scheme.get_storage().get(channel_id)
    if channel is None:
        raise ValueError(ERR_MISSING_CHANNEL)

    pending_id = None
    request_context = scheme.read_request_context(payment_payload)
    if request_context is not None:
        pending_id = request_context.pending_id
    if not pending_id or (
        channel.pending_request is None or channel.pending_request.pending_id != pending_id
    ):
        raise ValueError(ERR_CHANNEL_BUSY)

    if int(raw["voucher"]["maxClaimableAmount"]) != int(channel.charged_cumulative_amount):
        raise ValueError(ERR_CUMULATIVE_AMOUNT_MISMATCH)
    if raw["voucher"].get("signature") != channel.signature:
        raise ValueError(ERR_INVALID_VOUCHER_SIGNATURE)

    claim_entry = VoucherClaim(
        channel=channel_config,
        max_claimable_amount=str(raw["voucher"]["maxClaimableAmount"]),
        signature=raw["voucher"]["signature"],
        total_claimed=channel.charged_cumulative_amount,
    )

    remainder = int(channel.balance) - int(channel.charged_cumulative_amount)
    if remainder <= 0:
        raise ValueError(ERR_REFUND_NO_BALANCE)

    refund_amount_int = remainder
    raw_amount = raw.get("amount")
    if raw_amount is not None:
        if not _UINT_RE.match(str(raw_amount)):
            raise ValueError(ERR_REFUND_AMOUNT_INVALID)
        requested = int(raw_amount)
        if requested <= 0:
            raise ValueError(ERR_REFUND_AMOUNT_INVALID)
        if requested > remainder:
            raise ValueError(ERR_REFUND_NO_BALANCE)
        refund_amount_int = requested

    refund_amount = str(refund_amount_int)
    nonce = str(channel.refund_nonce or 0)

    signer = scheme.get_receiver_authorizer_signer()
    refund_authorizer_signature = (
        sign_refund(signer, channel_id, refund_amount, nonce, network)
        if signer is not None
        else None
    )
    claim_authorizer_signature = (
        sign_claim_batch(signer, [claim_entry], network) if signer is not None else None
    )

    scheme.remember_channel_snapshot(payment_payload, channel)

    out: dict[str, Any] = {
        "refundNonce": nonce,
        "claims": [claim_entry.to_dict()],
    }
    if raw_amount is None:
        out["amount"] = refund_amount
    if refund_authorizer_signature is not None:
        out["refundAuthorizerSignature"] = refund_authorizer_signature
    if claim_authorizer_signature is not None:
        out["claimAuthorizerSignature"] = claim_authorizer_signature
    return out


def handle_after_settle(scheme: BatchSettlementEvmScheme, ctx: SettleResultContext) -> None:
    """Update channel state after facilitator settle for refund / deposit payloads."""
    from ..types import ChannelConfig

    payment_payload = ctx.payment_payload
    requirements = ctx.requirements
    result = ctx.result
    if not result.success:
        return

    raw = payment_payload.payload
    storage = scheme.get_storage()

    if is_refund_payload(raw):
        channel_config = ChannelConfig.from_dict(raw["channelConfig"])
        channel_id = compute_channel_id(channel_config, str(requirements.network))
        request_context = scheme.read_request_context(payment_payload)
        pending_id = request_context.pending_id if request_context else None
        now = _now_ms()
        snapshot = parse_refund_settlement_snapshot(result.extra)

        def update_refund(current: Channel | None) -> Channel | None:
            if current is None:
                return current
            if not pending_id or (
                current.pending_request is None or current.pending_request.pending_id != pending_id
            ):
                return current
            if int(snapshot.balance) <= int(current.charged_cumulative_amount):
                # Channel fully drained — delete the record.
                return None
            next_ch = current.copy()
            next_ch.balance = snapshot.balance
            next_ch.total_claimed = snapshot.total_claimed
            next_ch.withdraw_requested_at = snapshot.withdraw_requested_at
            next_ch.refund_nonce = snapshot.refund_nonce
            next_ch.onchain_synced_at = now
            next_ch.last_request_timestamp = now
            next_ch.pending_request = None
            return next_ch

        update_result = storage.update_channel(channel_id, update_refund)
        if update_result.status == "unchanged":
            raise ValueError(ERR_CHANNEL_BUSY)
        return

    if is_voucher_payload(raw):
        return

    if is_deposit_payload(raw):
        voucher = raw["voucher"]
        channel_id = voucher["channelId"]
        channel_config = ChannelConfig.from_dict(raw["channelConfig"])
        request_context = scheme.read_request_context(payment_payload)
        pending_id = request_context.pending_id if request_context else None
        extra = result.extra or {}
        channel_state = read_channel_state_extra(extra)
        signed_max_claimable = str(voucher["maxClaimableAmount"])
        signature = voucher.get("signature", "0x")
        now = _now_ms()

        def update_deposit(current: Channel | None) -> Channel | None:
            if current is None:
                return current
            if not pending_id or (
                current.pending_request is None or current.pending_request.pending_id != pending_id
            ):
                return current
            charged_actual = str(int(current.charged_cumulative_amount) + int(requirements.amount))
            next_ch = current.copy()
            next_ch.channel_config = channel_config
            next_ch.charged_cumulative_amount = charged_actual
            next_ch.signed_max_claimable = signed_max_claimable
            next_ch.signature = signature
            next_ch.balance = read_extra_string(channel_state, "balance", current.balance)
            next_ch.total_claimed = read_extra_string(
                channel_state, "totalClaimed", current.total_claimed
            )
            next_ch.withdraw_requested_at = read_extra_number(
                channel_state, "withdrawRequestedAt", current.withdraw_requested_at
            )
            next_ch.refund_nonce = read_extra_number(
                channel_state, "refundNonce", current.refund_nonce
            )
            next_ch.onchain_synced_at = now
            next_ch.last_request_timestamp = now
            next_ch.pending_request = None
            return next_ch

        update_result = storage.update_channel(channel_id, update_deposit)
        if update_result.status == "updated" and update_result.channel is not None:
            scheme.remember_channel_snapshot(payment_payload, update_result.channel)
            return
        scheme.take_request_context(payment_payload)
        raise ValueError(ERR_CHANNEL_BUSY)


def handle_settle_failure(scheme: BatchSettlementEvmScheme, ctx: SettleFailureContext) -> None:
    """Clear this request's reservation after settlement throws."""
    scheme.clear_pending_request(ctx.payment_payload)


def handle_enrich_settlement_response(
    scheme: BatchSettlementEvmScheme, ctx: SettleResultContext
) -> dict[str, Any] | None:
    """Supply server-owned settlement response fields from the channel snapshot."""
    raw = ctx.payment_payload.payload
    if is_voucher_payload(raw):
        return None

    channel = scheme.take_channel_snapshot(ctx.payment_payload)
    if channel is None:
        return None

    if is_refund_payload(raw):
        return {
            "channelState": {
                "chargedCumulativeAmount": channel.charged_cumulative_amount,
            }
        }
    if is_deposit_payload(raw):
        return {
            "channelState": {
                "chargedCumulativeAmount": channel.charged_cumulative_amount,
            },
            "chargedAmount": ctx.requirements.amount,
        }
    return {
        "channelState": {
            "chargedCumulativeAmount": channel.charged_cumulative_amount,
        }
    }


__all__ = [
    "handle_before_settle",
    "handle_enrich_settlement_payload",
    "handle_after_settle",
    "handle_settle_failure",
    "handle_enrich_settlement_response",
]
