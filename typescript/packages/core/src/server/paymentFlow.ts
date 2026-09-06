import type { PaymentFlowName, PaymentFlowPhases, SchemeNetworkServer } from "../types/mechanisms";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "../types";
import type { DeepReadonly } from "../types/readonly";

/**
 * SDK-only ATM key for schemes with no on-wire assetTransferMethod.
 * Never emit `assetTransferMethod: "default"` on the 402 wire.
 */
export const SDK_DEFAULT_ASSET_TRANSFER_METHOD = "default";

/**
 * Closed set of payment-flow phase tables.
 *
 * Multi-settle flows (`escrow`) invoke settle lifecycle hooks once per settle.
 * Authors of side-effecting `beforeSettle` / `afterSettle` hooks should branch on
 * {@link SettleContext.phase} when used with those flows.
 */
export const PAYMENT_FLOWS: Record<PaymentFlowName, PaymentFlowPhases> = {
  authorization: {
    verifyBeforeHandler: true,
    settleBeforeHandler: false,
    settleAfterHandler: true,
  },
  upfront: {
    verifyBeforeHandler: false,
    settleBeforeHandler: true,
    settleAfterHandler: false,
  },
  escrow: {
    verifyBeforeHandler: false,
    settleBeforeHandler: true,
    settleAfterHandler: true,
  },
};

/**
 * Resolve assetTransferMethod and paymentFlow from a scheme table and requirements.
 *
 * Omit ATM → `scheme.defaultAssetTransferMethod`. Omit paymentFlow → that ATM's table default.
 * Unsupported ATM or flow throws.
 *
 * @param scheme - Scheme declaring default ATM and per-ATM paymentFlows
 * @param requirements - Payment requirements (possibly omitting ATM / paymentFlow)
 * @returns Resolved ATM and payment flow
 */
export function resolvePaymentFlow(
  scheme: Pick<SchemeNetworkServer, "defaultAssetTransferMethod" | "paymentFlows" | "scheme">,
  requirements: DeepReadonly<PaymentRequirements>,
): { assetTransferMethod: string; paymentFlow: PaymentFlowName } {
  const atm =
    typeof requirements.extra?.assetTransferMethod === "string"
      ? requirements.extra.assetTransferMethod
      : scheme.defaultAssetTransferMethod;

  const config = scheme.paymentFlows[atm];
  if (!config) {
    throw new Error(
      `[x402] Scheme "${scheme.scheme}" does not support assetTransferMethod "${atm}". ` +
        `Supported: ${Object.keys(scheme.paymentFlows).join(", ")}.`,
    );
  }
  if (!config.supported.includes(config.default)) {
    throw new Error(
      `[x402] Scheme "${scheme.scheme}" paymentFlows["${atm}"].default is not in supported.`,
    );
  }

  const requested = requirements.extra?.paymentFlow;
  const flow: PaymentFlowName =
    requested === undefined || requested === null ? config.default : (requested as PaymentFlowName);

  if (!config.supported.includes(flow)) {
    throw new Error(
      `[x402] Scheme "${scheme.scheme}" assetTransferMethod "${atm}" does not support paymentFlow "${String(requested)}". ` +
        `Supported: ${config.supported.join(", ")} (default: ${config.default}).`,
    );
  }

  return { assetTransferMethod: atm, paymentFlow: flow };
}

/**
 * Apply resolved payment-flow rules to 402 `extra`:
 * - Strip the SDK ATM sentinel `"default"` (never on the wire).
 * - When resolved flow is not `authorization`, set `extra.paymentFlow` so clients
 *   can distinguish trust models without scheme-specific knowledge.
 *
 * @param extra - Current requirements extra
 * @param resolved - Result of {@link resolvePaymentFlow}
 * @param resolved.assetTransferMethod - Resolved asset transfer method
 * @param resolved.paymentFlow - Resolved payment flow name
 * @returns New extra object with wire rules applied
 */
export function applyPaymentFlowWireExtra(
  extra: Record<string, unknown>,
  resolved: { assetTransferMethod: string; paymentFlow: PaymentFlowName },
): Record<string, unknown> {
  const next = { ...extra };
  if (
    resolved.assetTransferMethod === SDK_DEFAULT_ASSET_TRANSFER_METHOD ||
    next.assetTransferMethod === SDK_DEFAULT_ASSET_TRANSFER_METHOD
  ) {
    delete next.assetTransferMethod;
  }
  if (resolved.paymentFlow !== "authorization") {
    next.paymentFlow = resolved.paymentFlow;
  }
  return next;
}

/**
 * Resolve the phase table for a payment flow name.
 *
 * @param flow - Declared or default payment flow name
 * @returns Phase flags for verify/settle orchestration
 * @throws Error when `flow` is not one of the defined payment flows
 */
export function resolvePaymentFlowPhases(flow: PaymentFlowName): PaymentFlowPhases {
  const phases: PaymentFlowPhases | undefined = PAYMENT_FLOWS[flow];
  if (!phases) {
    throw new Error(
      `[x402] Unknown payment flow "${flow}". Expected one of: ${Object.keys(PAYMENT_FLOWS).join(", ")}.`,
    );
  }
  return phases;
}

/**
 * Resolve the settlement receipt to surface when a resource handler fails
 * after payment was already verified (and possibly settled before the handler).
 *
 * Prefers cancel/refund settle when present; on failed cancel, attaches deposit
 * recovery facts in `extra`. Otherwise echoes the before-handler deposit receipt.
 *
 * @param cancelSettlement - Result from {@link PaymentCancellationDispatcher.cancel}, if any
 * @param beforeHandlerSettlement - Completed before-handler settle, when present
 * @param beforeHandlerSettlement.result - Settle response from the before-handler deposit
 * @param paymentPayload - Client payment payload (for escrow deposit recovery fields)
 * @returns Settle response for PAYMENT-RESPONSE / MCP payment-response meta, or undefined
 */
export function resolveFailurePathSettlement(
  cancelSettlement: SettleResponse | void | undefined,
  beforeHandlerSettlement?: { result: SettleResponse },
  paymentPayload?: PaymentPayload,
): SettleResponse | undefined {
  if (cancelSettlement) {
    return cancelSettlement.success
      ? cancelSettlement
      : buildFailedCancelReceipt(cancelSettlement, beforeHandlerSettlement, paymentPayload);
  }
  if (beforeHandlerSettlement) {
    return beforeHandlerSettlement.result;
  }
  return undefined;
}

/**
 * Build a failed cancel receipt with deposit recovery facts in `extra`.
 *
 * @param cancelSettlement - Failed cancel settle from the facilitator
 * @param beforeHandlerSettlement - Completed before-handler deposit, when present
 * @param beforeHandlerSettlement.result - Settle response from the before-handler deposit
 * @param paymentPayload - Client payment payload
 * @returns Normalized settle response for transport encoding
 */
function buildFailedCancelReceipt(
  cancelSettlement: SettleResponse,
  beforeHandlerSettlement?: { result: SettleResponse },
  paymentPayload?: PaymentPayload,
): SettleResponse {
  const payload = paymentPayload?.payload as Record<string, unknown> | undefined;
  const channelId = payload?.channelId;
  return {
    success: false,
    errorReason: cancelSettlement.errorReason,
    errorMessage: cancelSettlement.errorMessage,
    payer: cancelSettlement.payer,
    transaction: "",
    network: cancelSettlement.network,
    extensions: cancelSettlement.extensions,
    extra: {
      ...cancelSettlement.extra,
      ...(beforeHandlerSettlement
        ? {
            depositTransaction: beforeHandlerSettlement.result.transaction,
            depositAmount: beforeHandlerSettlement.result.amount,
          }
        : {}),
      ...(typeof channelId === "string" && channelId ? { channelId } : {}),
    },
  };
}
