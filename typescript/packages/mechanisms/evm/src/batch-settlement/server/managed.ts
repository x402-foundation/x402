import { AfterSettleAbortError } from "@x402/core/server";
import type {
  SettleContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyResultContext,
} from "@x402/core/server";
import type { PaymentRequirements, SchemePaymentRequiredContext } from "@x402/core/types";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import type { BatchSettlementVoucherStateExtra } from "../types";
import { channelIdBindingError } from "../utils";
import * as Errors from "../errors";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import { buildRefundSettlementFields } from "./settle";
import { readChannelStateExtra, readExtraNumber, readExtraUintString } from "./utils";

/**
 * Managed admission belongs to the facilitator, including when a replica exists.
 *
 * @param scheme - Resource server scheme.
 * @param ctx - Verify request.
 * @returns An abort for invalid client fields, channel binding or deposit size.
 */
export async function beforeVerify(scheme: BatchSettlementEvmScheme, ctx: VerifyContext) {
  const raw = ctx.paymentPayload.payload;
  if (ctx.requirements.extra?.voucherManager !== "facilitator")
    return { abort: true as const, reason: Errors.ErrInvalidPayloadType };
  if (
    !isBatchSettlementDepositPayload(raw) &&
    !isBatchSettlementVoucherPayload(raw) &&
    !isBatchSettlementRefundPayload(raw)
  )
    return;
  if ("pendingId" in raw) return { abort: true as const, reason: Errors.ErrUnexpectedPendingId };
  if ("cancel" in raw) return { abort: true as const, reason: Errors.ErrUnexpectedCancel };
  const reason = channelIdBindingError(
    raw.channelConfig,
    raw.voucher.channelId,
    ctx.requirements.network,
  );
  if (reason) return { abort: true as const, reason };
  if (
    isBatchSettlementDepositPayload(raw) &&
    scheme.getEnforceMinDeposit() &&
    BigInt(raw.deposit.amount) < BigInt(await scheme.resolveMinDepositHint(ctx.requirements))
  ) {
    return { abort: true as const, reason: Errors.ErrDepositBelowMinDeposit };
  }
}

/**
 * Keeps the facilitator's admission identity and view for settlement and refund consent.
 *
 * @param scheme - Resource server scheme.
 * @param ctx - Facilitator verification result.
 * @returns A refund handler shortcut or an abort for an incomplete admission response.
 */
export async function afterVerify(scheme: BatchSettlementEvmScheme, ctx: VerifyResultContext) {
  const raw = ctx.paymentPayload.payload;
  if (
    !isBatchSettlementDepositPayload(raw) &&
    !isBatchSettlementVoucherPayload(raw) &&
    !isBatchSettlementRefundPayload(raw)
  )
    return;
  const extra = ctx.result.extra;
  if (!ctx.result.isValid) {
    if (
      ctx.result.invalidReason === Errors.ErrCumulativeAmountMismatch ||
      ctx.result.invalidReason === Errors.ErrCumulativeAmountBelowClaimed
    ) {
      scheme.mergeRequestContext(ctx.paymentPayload, {
        correctiveChannelState: readChannelStateExtra(extra),
        correctiveVoucherState: extra?.voucherState as BatchSettlementVoucherStateExtra | undefined,
      });
    }
    return;
  }
  const pendingId = typeof extra?.pendingId === "string" ? extra.pendingId : undefined;
  const charged = readExtraUintString(extra, "chargedCumulativeAmount");
  const balance = readExtraUintString(extra, "balance");
  const totalClaimed = readExtraUintString(extra, "totalClaimed");
  const nonce = readExtraUintString(extra, "refundNonce");
  // Preserve admission before checking the rest of the response so core can cancel it.
  scheme.mergeRequestContext(ctx.paymentPayload, { pendingId, channelId: raw.voucher.channelId });
  if (
    !pendingId ||
    charged === undefined ||
    balance === undefined ||
    totalClaimed === undefined ||
    nonce === undefined
  ) {
    return { abort: true as const, reason: Errors.ErrVerificationStateUnavailable };
  }
  scheme.mergeRequestContext(ctx.paymentPayload, {
    managedRefundNonce: nonce,
    channelSnapshot: {
      channelId: raw.voucher.channelId,
      channelConfig: raw.channelConfig,
      chargedCumulativeAmount: charged,
      signedMaxClaimable: raw.voucher.maxClaimableAmount,
      signature: raw.voucher.signature,
      balance,
      totalClaimed,
      withdrawRequestedAt: readExtraNumber(extra, "withdrawRequestedAt", 0),
      refundNonce: Number(nonce),
      lastRequestTimestamp: Date.now(),
    },
  });
  if (isBatchSettlementRefundPayload(raw)) {
    return {
      skipHandler: true as const,
      response: {
        contentType: "application/json",
        body: { message: "Refund acknowledged", channelId: raw.voucher.channelId },
      },
    };
  }
}

/**
 * Copies facilitator corrective state onto the matching payment option.
 *
 * @param scheme - Resource server scheme.
 * @param ctx - Payment-required response context.
 * @returns Corrected requirements when the facilitator supplied a recovery proof.
 */
export async function enrichPaymentRequiredResponse(
  scheme: BatchSettlementEvmScheme,
  ctx: SchemePaymentRequiredContext,
) {
  if (
    !ctx.paymentPayload ||
    (ctx.error !== Errors.ErrCumulativeAmountMismatch &&
      ctx.error !== Errors.ErrCumulativeAmountBelowClaimed)
  )
    return;
  const request = scheme.takeRequestContext(ctx.paymentPayload);
  if (!request?.correctiveChannelState || !request.correctiveVoucherState) return;
  return ctx.requirements.map(requirements =>
    requirements.scheme === scheme.scheme &&
    requirements.network === ctx.paymentPayload!.accepted.network
      ? {
          ...requirements,
          extra: {
            ...requirements.extra,
            channelState: request.correctiveChannelState,
            voucherState: request.correctiveVoucherState,
          },
        }
      : requirements,
  );
}

/**
 * Releases verified admission after a canceled handler without charging it.
 *
 * @param ctx - Verified cancellation context, including verify-only flows.
 * @returns Zero-charge requirements for core's cancel settle.
 */
export function settleOnCancel(ctx: VerifiedPaymentCanceledContext): PaymentRequirements | void {
  if (
    !["handler_failed", "handler_threw", "after_verify_aborted", "settlement_failed"].includes(
      ctx.reason,
    )
  )
    return;
  const raw = ctx.paymentPayload.payload;
  if (
    !isBatchSettlementDepositPayload(raw) &&
    !isBatchSettlementVoucherPayload(raw) &&
    !isBatchSettlementRefundPayload(raw)
  )
    return;
  return { ...ctx.requirements, amount: "0" };
}

/**
 * Forwards admission on ordinary settles and signs only server-owned refund consent.
 *
 * @param scheme - Resource server scheme.
 * @param ctx - Settlement context.
 * @returns Server-authored fields merged into the facilitator request.
 */
export async function enrichSettlementPayload(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
) {
  const raw = ctx.paymentPayload.payload;
  if (
    !isBatchSettlementDepositPayload(raw) &&
    !isBatchSettlementVoucherPayload(raw) &&
    !isBatchSettlementRefundPayload(raw)
  )
    return;
  const request = scheme.readRequestContext(ctx.paymentPayload);
  const pendingId = request?.pendingId;
  if (!pendingId) throw new Error(Errors.ErrVerificationStateUnavailable);
  if (ctx.phase === "cancel") return { pendingId, cancel: true };
  if (!isBatchSettlementRefundPayload(raw)) return { pendingId };
  if (!request?.channelSnapshot) throw new Error(Errors.ErrMissingChannel);
  const fields = await buildRefundSettlementFields({
    channel: request.channelSnapshot,
    payload: raw,
    network: ctx.requirements.network,
    signer: scheme.getRefundAuthorizerSigner(),
    includeClaimAuthorizerSignature: false,
    nonce: request.managedRefundNonce,
  });
  return { ...fields, pendingId };
}

/**
 * Updates an optional local replica from the authoritative facilitator receipt.
 * It never supplies admission, cumulative checks or corrective responses.
 *
 * @param scheme - Resource server scheme.
 * @param ctx - Confirmed settlement result.
 */
export async function afterSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<void> {
  try {
    if (!ctx.result.success || ctx.phase === "cancel") return;
    const raw = ctx.paymentPayload.payload;
    if (
      !isBatchSettlementDepositPayload(raw) &&
      !isBatchSettlementVoucherPayload(raw) &&
      !isBatchSettlementRefundPayload(raw)
    )
      return;
    const snapshot = readChannelStateExtra(ctx.result.extra);
    const charged = readExtraUintString(snapshot, "chargedCumulativeAmount");
    const balance = readExtraUintString(snapshot, "balance");
    const totalClaimed = readExtraUintString(snapshot, "totalClaimed");
    const refundNonce = readExtraUintString(snapshot, "refundNonce");
    const withdrawRequestedAt = readExtraUintString(snapshot, "withdrawRequestedAt");
    if (
      charged === undefined ||
      balance === undefined ||
      totalClaimed === undefined ||
      refundNonce === undefined ||
      withdrawRequestedAt === undefined
    )
      throw new AfterSettleAbortError(
        Errors.ErrVoucherStoreUnavailable,
        "Managed settlement is missing a valid channel snapshot",
      );
    try {
      await scheme.getStorage().updateChannel(raw.voucher.channelId, current => {
        if (isBatchSettlementRefundPayload(raw) && BigInt(balance) <= BigInt(charged))
          return undefined;
        if (current && BigInt(current.chargedCumulativeAmount) > BigInt(charged)) return current;
        const next: Channel = {
          channelId: raw.voucher.channelId,
          channelConfig: raw.channelConfig,
          chargedCumulativeAmount: charged,
          signedMaxClaimable: raw.voucher.maxClaimableAmount,
          signature: raw.voucher.signature,
          balance,
          totalClaimed,
          withdrawRequestedAt: Number(withdrawRequestedAt),
          refundNonce: Number(refundNonce),
          lastRequestTimestamp: Date.now(),
        };
        return next;
      });
    } catch (error) {
      // The facilitator already committed. A replica outage cannot undo its receipt.
      console.warn(
        `[x402] Managed channel replica update failed for ${raw.voucher.channelId}:`,
        error instanceof Error ? error.message : String(error),
      );
    }
  } finally {
    scheme.takeRequestContext(ctx.paymentPayload);
  }
}
