import type { PaymentResponseContext } from "@x402/core/client";
import type { SchemeClientHooks } from "@x402/core/types";
import { isBatchSettlementRefundPayload } from "../types";
import type { BatchSettlementClientDeps } from "./channel";
import { processSettleResponse, updateChannelAfterRefund } from "./channel";
import { processCorrectivePaymentRequired } from "./recovery";

/**
 * Creates storage-aware client hooks for batch-settlement payment responses.
 *
 * @param deps - Client identity and storage inputs.
 * @returns Scheme hooks for response reconciliation and corrective recovery.
 */
export function createBatchSettlementClientHooks(
  deps: BatchSettlementClientDeps,
): SchemeClientHooks {
  return {
    onPaymentResponse: ctx => handleBatchSettlementPaymentResponse(deps, ctx),
  };
}

/**
 * Reconciles batch-settlement client state after a paid request or refund attempt.
 *
 * @param deps - Client identity and storage inputs.
 * @param ctx - Core payment response context.
 * @returns A recovery signal when corrective recovery succeeds.
 */
export async function handleBatchSettlementPaymentResponse(
  deps: BatchSettlementClientDeps,
  ctx: PaymentResponseContext,
): Promise<void | { recovered: true }> {
  if (ctx.settleResponse) {
    if (isBatchSettlementRefundPayload(ctx.paymentPayload.payload)) {
      const extra = ctx.settleResponse.extra ?? {};
      const channelState = extra.channelState;
      const channelId =
        typeof channelState === "object" && channelState !== null && "channelId" in channelState
          ? channelState.channelId
          : undefined;
      if (typeof channelId === "string" && channelId) {
        await updateChannelAfterRefund(deps.storage, channelId.toLowerCase(), extra);
      }
      return;
    }

    await processSettleResponse(deps.storage, ctx.settleResponse);
    return;
  }

  if (ctx.paymentRequired) {
    const recovered = await processCorrectivePaymentRequired(deps, ctx.paymentRequired);
    return recovered ? { recovered: true } : undefined;
  }
}
