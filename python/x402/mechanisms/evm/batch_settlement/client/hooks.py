"""Payment-response handler for the batch-settlement client."""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass
from typing import Any

from .....schemas import PaymentRequired, SettleResponse
from ..types import (
    is_refund_payload,
)
from .channel import (
    BatchSettlementClientDeps,
    process_settle_response,
    update_channel_after_refund,
)
from .recovery import process_corrective_payment_required


@dataclass
class PaymentResponseContext:
    payment_payload: dict[str, Any] | None = None
    settle_response: SettleResponse | None = None
    payment_required: PaymentRequired | None = None


@dataclass
class RecoverySignal:
    recovered: bool = True


def handle_batch_settlement_payment_response(
    deps: BatchSettlementClientDeps,
    ctx: PaymentResponseContext,
) -> RecoverySignal | None:
    """Reconcile local channel state after a paid request or refund attempt."""
    if ctx.settle_response is not None:
        if ctx.payment_payload is not None and is_refund_payload(ctx.payment_payload):
            extra = ctx.settle_response.extra or {}
            channel_state = extra.get("channelState")
            channel_id = channel_state.get("channelId") if isinstance(channel_state, dict) else None
            if isinstance(channel_id, str) and channel_id:
                update_channel_after_refund(deps.storage, channel_id.lower(), extra)
            return None

        process_settle_response(deps.storage, ctx.settle_response)
        return None

    if ctx.payment_required is not None:
        recovered = process_corrective_payment_required(deps, ctx.payment_required)
        return RecoverySignal(recovered=True) if recovered else None
    return None


def create_batch_settlement_client_hooks(
    deps: BatchSettlementClientDeps,
) -> Callable[[PaymentResponseContext], RecoverySignal | None]:
    def on_payment_response(ctx: PaymentResponseContext) -> RecoverySignal | None:
        return handle_batch_settlement_payment_response(deps, ctx)

    return on_payment_response


__all__ = [
    "PaymentResponseContext",
    "RecoverySignal",
    "create_batch_settlement_client_hooks",
    "handle_batch_settlement_payment_response",
]
