"""Payment-flow phase tables and 402 wire-extra helpers.

Mirrors typescript/packages/core/src/server/paymentFlow.ts.
"""

from __future__ import annotations

from typing import Any

from .interfaces import (
    PaymentFlowConfig,
    PaymentFlowName,
    PaymentFlowPhases,
    ResolvedPaymentFlow,
    SchemeNetworkServer,
)
from .schemas import PaymentPayload, PaymentRequirements, SettleResponse

SDK_DEFAULT_ASSET_TRANSFER_METHOD = "default"

PAYMENT_FLOWS: dict[PaymentFlowName, PaymentFlowPhases] = {
    "authorization": PaymentFlowPhases(
        verify_before_handler=True,
        settle_before_handler=False,
        settle_after_handler=True,
    ),
    "upfront": PaymentFlowPhases(
        verify_before_handler=False,
        settle_before_handler=True,
        settle_after_handler=False,
    ),
    "escrow": PaymentFlowPhases(
        verify_before_handler=False,
        settle_before_handler=True,
        settle_after_handler=True,
    ),
}

AUTHORIZATION_PAYMENT_FLOW: PaymentFlowConfig = {
    "supported": ("authorization",),
    "default": "authorization",
}


def resolve_payment_flow(
    scheme: SchemeNetworkServer,
    requirements: PaymentRequirements,
) -> ResolvedPaymentFlow:
    """Resolve assetTransferMethod and paymentFlow from a scheme table.

    Omit ATM → ``scheme.default_asset_transfer_method``. Omit paymentFlow →
    that ATM's table default. Unsupported ATM or flow raises ``ValueError``.
    """
    extra = requirements.extra or {}
    extra_atm = extra.get("assetTransferMethod")
    atm = extra_atm if isinstance(extra_atm, str) else scheme.default_asset_transfer_method

    config = scheme.payment_flows.get(atm)
    if config is None:
        supported = ", ".join(scheme.payment_flows)
        raise ValueError(
            f'[x402] Scheme "{scheme.scheme}" does not support assetTransferMethod "{atm}". '
            f"Supported: {supported}."
        )
    if config["default"] not in config["supported"]:
        raise ValueError(
            f'[x402] Scheme "{scheme.scheme}" paymentFlows["{atm}"].default is not in supported.'
        )

    requested = extra.get("paymentFlow")
    flow: PaymentFlowName = config["default"] if requested is None else requested  # type: ignore[assignment]

    if flow not in config["supported"]:
        supported = ", ".join(config["supported"])
        raise ValueError(
            f'[x402] Scheme "{scheme.scheme}" assetTransferMethod "{atm}" '
            f'does not support paymentFlow "{requested}". '
            f"Supported: {supported} (default: {config['default']})."
        )

    return ResolvedPaymentFlow(asset_transfer_method=atm, payment_flow=flow)


def apply_payment_flow_wire_extra(
    extra: dict[str, Any],
    resolved: ResolvedPaymentFlow,
) -> dict[str, Any]:
    """Apply resolved payment-flow rules to 402 ``extra``.

    Strip the SDK ATM sentinel ``"default"`` (never on the wire). When the
    resolved flow is not ``authorization``, set ``extra.paymentFlow`` so clients
    can distinguish trust models without scheme-specific knowledge.
    """
    next_extra = dict(extra)
    if (
        resolved.asset_transfer_method == SDK_DEFAULT_ASSET_TRANSFER_METHOD
        or next_extra.get("assetTransferMethod") == SDK_DEFAULT_ASSET_TRANSFER_METHOD
    ):
        next_extra.pop("assetTransferMethod", None)
    if resolved.payment_flow != "authorization":
        next_extra["paymentFlow"] = resolved.payment_flow
    return next_extra


def resolve_payment_flow_phases(flow: PaymentFlowName) -> PaymentFlowPhases:
    """Resolve the phase table for a payment flow name."""
    phases = PAYMENT_FLOWS.get(flow)
    if phases is None:
        expected = ", ".join(PAYMENT_FLOWS)
        raise ValueError(f'[x402] Unknown payment flow "{flow}". Expected one of: {expected}.')
    return phases


def resolve_failure_path_settlement(
    cancel_settlement: SettleResponse | None,
    before_handler_settlement: Any | None = None,
    payment_payload: PaymentPayload | None = None,
) -> SettleResponse | None:
    """Resolve the settlement receipt to surface when a resource handler fails.

    Prefers cancel/refund settle when present; on failed cancel, attaches deposit
    recovery facts in ``extra``. Otherwise echoes the before-handler deposit receipt.
    """
    if cancel_settlement is not None:
        if cancel_settlement.success:
            return cancel_settlement
        return _build_failed_cancel_receipt(
            cancel_settlement, before_handler_settlement, payment_payload
        )
    if before_handler_settlement is not None:
        return before_handler_settlement.result
    return None


def _build_failed_cancel_receipt(
    cancel_settlement: SettleResponse,
    before_handler_settlement: Any | None,
    payment_payload: PaymentPayload | None,
) -> SettleResponse:
    """Build a failed cancel receipt with deposit recovery facts in ``extra``."""
    extra = dict(cancel_settlement.extra or {})
    if before_handler_settlement is not None:
        extra["depositTransaction"] = before_handler_settlement.result.transaction
        extra["depositAmount"] = before_handler_settlement.result.amount
    payload = payment_payload.payload if payment_payload is not None else None
    if isinstance(payload, dict):
        channel_id = payload.get("channelId")
        if isinstance(channel_id, str) and channel_id:
            extra["channelId"] = channel_id
    return SettleResponse(
        success=False,
        error_reason=cancel_settlement.error_reason,
        error_message=cancel_settlement.error_message,
        payer=cancel_settlement.payer,
        transaction="",
        network=cancel_settlement.network,
        extensions=cancel_settlement.extensions,
        extra=extra or None,
    )
