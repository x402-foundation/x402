"""Shared types and helpers for batch-settlement channel managers."""

from __future__ import annotations

import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Literal

from .....schemas import (
    PaymentPayload,
    PaymentRequirements,
    SettleResponse,
)
from .....server_base import FacilitatorClient, FacilitatorClientSync
from ..constants import SCHEME_BATCH_SETTLEMENT
from ..types import VoucherClaim
from .storage import Channel

if TYPE_CHECKING:
    from .scheme import BatchSettlementEvmScheme

AutoJob = Literal["claim", "settle", "refund"]
AUTO_JOB_PRIORITY: tuple[AutoJob, ...] = ("claim", "settle", "refund")


@dataclass
class ChannelManagerConfigSync:
    scheme: BatchSettlementEvmScheme
    facilitator: FacilitatorClientSync
    receiver: str
    token: str
    network: str


@dataclass
class ChannelManagerConfig:
    scheme: BatchSettlementEvmScheme
    facilitator: FacilitatorClient
    receiver: str
    token: str
    network: str


@dataclass
class AutoSettlementContext:
    now: int
    last_claim_time: int
    last_settle_time: int
    pending_settle: bool


ClaimChannelSelectorSync = Callable[[list[Channel], AutoSettlementContext], list[Channel]]
RefundChannelSelectorSync = Callable[[list[Channel], AutoSettlementContext], list[Channel]]

ClaimChannelSelector = Callable[
    [list[Channel], AutoSettlementContext],
    list[Channel] | Awaitable[list[Channel]],
]
RefundChannelSelector = Callable[
    [list[Channel], AutoSettlementContext],
    list[Channel] | Awaitable[list[Channel]],
]
ShouldSettleSelector = Callable[
    [AutoSettlementContext],
    bool | Awaitable[bool],
]


@dataclass
class ClaimOptions:
    max_claims_per_batch: int | None = None
    idle_secs: int | None = None
    select_claim_channels: ClaimChannelSelectorSync | ClaimChannelSelector | None = None


@dataclass
class ClaimResult:
    vouchers: int
    transaction: str


@dataclass
class SettleResult:
    transaction: str


@dataclass
class RefundResult:
    channel: str
    transaction: str


@dataclass
class AutoSettlementConfig:
    claim_interval_secs: int | None = None
    settle_interval_secs: int | None = None
    refund_interval_secs: int | None = None
    max_claims_per_batch: int | None = None
    select_claim_channels: ClaimChannelSelectorSync | ClaimChannelSelector | None = None
    should_settle: ShouldSettleSelector | Callable[[AutoSettlementContext], bool] | None = None
    select_refund_channels: RefundChannelSelectorSync | RefundChannelSelector | None = None
    on_claim: Callable[[ClaimResult], None] | None = None
    on_settle: Callable[[SettleResult], None] | None = None
    on_refund: Callable[[RefundResult], None] | None = None
    on_error: Callable[[BaseException], None] | None = None


def now_ms() -> int:
    return int(time.time() * 1000)


def format_facilitator_failure(operation: str, response: SettleResponse) -> str:
    reason = response.error_reason or "unknown"
    message = response.error_message or ""
    return f"{operation} failed: {reason} — {message}"


def has_live_pending_request(channel: Channel, now_ms: int) -> bool:
    return channel.pending_request is not None and channel.pending_request.expires_at > now_ms


def get_claimable_vouchers_from_channels(
    channels: list[Channel], idle_secs: int | None
) -> list[VoucherClaim]:
    now = now_ms()
    out: list[VoucherClaim] = []
    for c in channels:
        if int(c.charged_cumulative_amount) <= int(c.total_claimed):
            continue
        if idle_secs is not None:
            idle_ms = now - c.last_request_timestamp
            if idle_ms < idle_secs * 1000:
                continue
        out.append(
            VoucherClaim(
                channel=c.channel_config,
                max_claimable_amount=c.signed_max_claimable,
                signature=c.signature,
                total_claimed=c.charged_cumulative_amount,
            )
        )
    return out


def build_refund_claims(channel: Channel) -> list[VoucherClaim]:
    if int(channel.charged_cumulative_amount) <= int(channel.total_claimed):
        return []
    return [
        VoucherClaim(
            channel=channel.channel_config,
            max_claimable_amount=channel.signed_max_claimable,
            signature=channel.signature,
            total_claimed=channel.charged_cumulative_amount,
        )
    ]


def build_payment_requirements(receiver: str, token: str, network: str) -> PaymentRequirements:
    return PaymentRequirements(
        scheme=SCHEME_BATCH_SETTLEMENT,
        network=network,
        asset=token,
        amount="0",
        pay_to=receiver,
        max_timeout_seconds=0,
        extra={},
    )


def build_settle_payment_payload(
    requirements: PaymentRequirements, receiver: str, token: str
) -> PaymentPayload:
    return PaymentPayload(
        x402_version=2,
        payload={"type": "settle", "receiver": receiver, "token": token},
        accepted=requirements,
    )


def build_claim_payment_payload(
    claims: list[VoucherClaim],
    requirements: PaymentRequirements,
    claim_authorizer_signature: str | None,
) -> PaymentPayload:
    inner_payload: dict[str, Any] = {
        "type": "claim",
        "claims": [c.to_dict() for c in claims],
    }
    if claim_authorizer_signature is not None:
        inner_payload["claimAuthorizerSignature"] = claim_authorizer_signature
    return PaymentPayload(x402_version=2, payload=inner_payload, accepted=requirements)


def build_refund_payment_payload(
    target: Channel,
    claims: list[VoucherClaim],
    requirements: PaymentRequirements,
    refund_amount: str,
    nonce: str,
    refund_authorizer_signature: str | None,
    claim_authorizer_signature: str | None,
) -> PaymentPayload:
    inner_payload: dict[str, Any] = {
        "type": "refund",
        "channelConfig": target.channel_config.to_dict(),
        "voucher": {
            "channelId": target.channel_id,
            "maxClaimableAmount": target.signed_max_claimable,
            "signature": target.signature,
        },
        "amount": refund_amount,
        "refundNonce": nonce,
        "claims": [c.to_dict() for c in claims],
    }
    if refund_authorizer_signature is not None:
        inner_payload["refundAuthorizerSignature"] = refund_authorizer_signature
    if claim_authorizer_signature is not None:
        inner_payload["claimAuthorizerSignature"] = claim_authorizer_signature
    return PaymentPayload(x402_version=2, payload=inner_payload, accepted=requirements)


def get_idle_channels_for_refund(channels: list[Channel], idle_secs: int) -> list[Channel]:
    now = now_ms()
    idle_ms = idle_secs * 1000
    out: list[Channel] = []
    for c in channels:
        if int(c.balance) == 0:
            continue
        if has_live_pending_request(c, now):
            continue
        if now - c.last_request_timestamp < idle_ms:
            continue
        out.append(c)
    return out


__all__ = [
    "AUTO_JOB_PRIORITY",
    "AutoJob",
    "AutoSettlementConfig",
    "AutoSettlementContext",
    "ChannelManagerConfig",
    "ChannelManagerConfigSync",
    "ClaimChannelSelector",
    "ClaimChannelSelectorSync",
    "ClaimOptions",
    "ClaimResult",
    "RefundChannelSelector",
    "RefundChannelSelectorSync",
    "RefundResult",
    "SettleResult",
    "ShouldSettleSelector",
    "build_claim_payment_payload",
    "build_payment_requirements",
    "build_refund_claims",
    "build_refund_payment_payload",
    "build_settle_payment_payload",
    "format_facilitator_failure",
    "get_claimable_vouchers_from_channels",
    "get_idle_channels_for_refund",
    "has_live_pending_request",
    "now_ms",
]
