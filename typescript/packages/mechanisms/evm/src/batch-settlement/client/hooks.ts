import type { SchemeClientHooks } from "@x402/core/types";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  type BatchSettlementChannelStateExtra,
} from "../types";
import { computeChannelId } from "../utils";
import {
  type BatchSettlementClientDeps,
  buildChannelConfig,
  updateChannelAfterRefund,
  updateChannelFromSettle,
} from "./channel";
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
    onPaymentResponse: async ctx => {
      const settleResponse = ctx.settleResponse;
      if (settleResponse) {
        if (!settleResponse.success) {
          return;
        }

        const payload = ctx.paymentPayload.payload;
        const channelId = computeChannelId(
          buildChannelConfig(deps, ctx.requirements),
          ctx.requirements.network,
        );
        if (isBatchSettlementRefundPayload(payload)) {
          await updateChannelAfterRefund(deps.storage, channelId.toLowerCase(), payload.amount);
          return;
        }
        const chargedAmount = settleResponse.extra?.chargedAmount;
        if (chargedAmount !== undefined && typeof chargedAmount !== "string") {
          throw new Error("invalid chargedAmount: not a non-negative integer");
        }
        const channelState = settleResponse.extra?.channelState as
          | BatchSettlementChannelStateExtra
          | undefined;
        await updateChannelFromSettle(deps.storage, {
          server: {
            chargedAmount,
            chargedCumulativeAmount: channelState?.chargedCumulativeAmount,
          },
          local: {
            channelId,
            requestAmount: ctx.requirements.amount,
            depositAmount: isBatchSettlementDepositPayload(payload)
              ? payload.deposit.amount
              : undefined,
          },
        });
        return;
      }

      if (ctx.paymentRequired) {
        const recovered = await processCorrectivePaymentRequired(deps, ctx.paymentRequired);
        return recovered ? { recovered: true } : undefined;
      }
    },
  };
}
