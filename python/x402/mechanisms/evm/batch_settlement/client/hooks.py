"""Payment-response handler for the batch-settlement client."""

from __future__ import annotations

from types import SimpleNamespace

from .....schemas import PaymentResponseContext, RecoveredResponseResult
from ..types import is_deposit_payload, is_refund_payload
from ..utils import compute_channel_id
from .channel import (
    BatchSettlementClientDeps,
    ChannelSettleLocal,
    build_channel_config,
    update_channel_after_refund,
    update_channel_from_settle,
)
from .recovery import process_corrective_payment_required


def create_batch_settlement_client_hooks(
    deps: BatchSettlementClientDeps,
) -> SimpleNamespace:
    """Create storage-aware client hooks for batch-settlement payment responses."""

    def on_payment_response(ctx: PaymentResponseContext) -> RecoveredResponseResult | None:
        settle_response = ctx.settle_response
        if settle_response is not None:
            if not settle_response.success:
                return None

            payload = ctx.payment_payload.payload
            channel_id = compute_channel_id(
                build_channel_config(deps, ctx.requirements),
                str(ctx.requirements.network),
            )
            if is_refund_payload(payload):
                amount = payload.get("amount")
                update_channel_after_refund(
                    deps.storage,
                    channel_id.lower(),
                    amount if isinstance(amount, str) else None,
                )
                return None
            extra = settle_response.extra
            charged_amount: str | None = None
            if extra is not None and "chargedAmount" in extra:
                raw_charged = extra["chargedAmount"]
                if not isinstance(raw_charged, str):
                    raise ValueError("invalid chargedAmount: not a non-negative integer")
                charged_amount = raw_charged
            channel_state = extra.get("channelState") if extra else None
            charged_cumulative: str | None = None
            if isinstance(channel_state, dict):
                raw_cumulative = channel_state.get("chargedCumulativeAmount")
                if isinstance(raw_cumulative, str):
                    charged_cumulative = raw_cumulative
            server: dict[str, str] = {}
            if charged_amount is not None:
                server["charged_amount"] = charged_amount
            if charged_cumulative is not None:
                server["charged_cumulative_amount"] = charged_cumulative
            local: ChannelSettleLocal = {
                "channel_id": channel_id,
                "request_amount": ctx.requirements.amount,
            }
            if is_deposit_payload(payload):
                local["deposit_amount"] = payload["deposit"]["amount"]
            update_channel_from_settle(deps.storage, {"server": server, "local": local})
            return None

        if ctx.payment_required is not None:
            recovered = process_corrective_payment_required(deps, ctx.payment_required)
            return RecoveredResponseResult() if recovered else None
        return None

    return SimpleNamespace(on_payment_response=on_payment_response)


__all__ = [
    "create_batch_settlement_client_hooks",
]
