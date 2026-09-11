import type { SettleResponse } from "@x402/core/types";
import type { SettleContext, SettleFailureContext, SettleResultContext } from "@x402/core/server";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import type { BatchSettlementPaymentResponseExtra, BatchSettlementVoucherClaim } from "../types";
import { computeChannelId } from "../utils";
import * as Errors from "../errors";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import {
  parseRefundSettlementSnapshot,
  readChannelStateExtra,
  readExtraNumber,
  readExtraString,
} from "./utils";

/**
 * Returns whether another request holds a live admission lock.
 *
 * Used for deposit/refund holder checks. Voucher settle relies on the charge CAS.
 * This request proceeds when it holds the lock or no lock is present (lost/expired).
 * Lock-store failures are optimistic.
 *
 * @param scheme - Owning scheme for lock-store access.
 * @param channelId - Channel to inspect.
 * @param pendingId - This request's lock owner, if any.
 * @returns Whether a different `pendingId` currently holds the lock.
 */
async function heldByOther(
  scheme: BatchSettlementEvmScheme,
  channelId: string,
  pendingId: string | undefined,
): Promise<boolean> {
  try {
    const locks = scheme.getLockStorage();
    if (pendingId && (await locks.isHeld(channelId, pendingId))) {
      return false;
    }
    return await locks.isHeld(channelId);
  } catch {
    return false;
  }
}

/**
 * Converts stored channel state into the public response snapshot shape.
 *
 * @param channel - Stored channel state.
 * @param chargedCumulativeAmount - Optional current charged cumulative amount.
 * @returns Response-ready channel snapshot.
 */
function channelStateExtra(
  channel: Pick<
    Channel,
    "channelId" | "balance" | "totalClaimed" | "withdrawRequestedAt" | "refundNonce"
  >,
  chargedCumulativeAmount?: string,
): NonNullable<BatchSettlementPaymentResponseExtra["channelState"]> {
  return {
    channelId: channel.channelId as `0x${string}`,
    balance: channel.balance,
    totalClaimed: channel.totalClaimed,
    withdrawRequestedAt: channel.withdrawRequestedAt,
    refundNonce: String(channel.refundNonce),
    ...(chargedCumulativeAmount !== undefined ? { chargedCumulativeAmount } : {}),
  };
}

/**
 * Lifecycle hook: runs before the facilitator settles a payment.
 *
 * Voucher payloads increment `chargedCumulativeAmount` locally and return `skip` so
 * the middleware responds without an onchain settle. Refund and deposit payloads
 * fall through to facilitator settlement; their durable rows update in `afterSettle`.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Settle lifecycle context (payload and requirements).
 * @returns Nothing to proceed; `abort` to fail; `skip` with a result to short-circuit settlement.
 */
export async function handleBeforeSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
): Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: SettleResponse }
> {
  const { paymentPayload, requirements } = ctx;

  const raw = paymentPayload.payload;
  const storage = scheme.getStorage();

  if (!isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const { voucher } = raw;
  const channelId = voucher.channelId;
  const requestContext = scheme.readRequestContext(paymentPayload);
  const snapshot = requestContext?.channelSnapshot;
  const localVerify = requestContext?.localVerify === true;
  const now = Date.now();

  const increment = BigInt(requirements.amount);
  const signedCap = BigInt(voucher.maxClaimableAmount);
  let outcome:
    | { status: "missing" }
    | { status: "cap_exceeded"; charged: string }
    | { status: "committed"; previous: Channel; current: Channel }
    | undefined;

  const updateResult = await storage.updateChannel(channelId, current => {
    const base = current ?? snapshot;
    if (!base) {
      outcome = { status: "missing" };
      return current;
    }

    const newCharged = BigInt(base.chargedCumulativeAmount) + increment;
    if (newCharged > signedCap) {
      outcome = { status: "cap_exceeded", charged: newCharged.toString() };
      return current;
    }

    const updatedChannel: Channel = {
      ...base,
      ...(localVerify || !snapshot
        ? {}
        : {
            balance: snapshot.balance,
            totalClaimed: snapshot.totalClaimed,
            withdrawRequestedAt: snapshot.withdrawRequestedAt,
            refundNonce: snapshot.refundNonce,
            onchainSyncedAt: now,
          }),
      chargedCumulativeAmount: newCharged.toString(),
      signedMaxClaimable: voucher.maxClaimableAmount,
      signature: voucher.signature,
      lastRequestTimestamp: now,
    };
    outcome = { status: "committed", previous: base, current: updatedChannel };
    return updatedChannel;
  });

  await scheme.clearPendingRequest(paymentPayload);

  if (outcome?.status === "missing") {
    return {
      abort: true,
      reason: Errors.ErrMissingChannel,
      message: "No channel record",
    };
  }

  if (outcome?.status === "cap_exceeded") {
    return {
      abort: true,
      reason: Errors.ErrChargeExceedsSignedCumulative,
      message: `Charged ${outcome.charged} exceeds signed max ${signedCap.toString()}`,
    };
  }

  if (updateResult.status !== "updated" || outcome?.status !== "committed") {
    return {
      abort: true,
      reason: Errors.ErrChannelBusy,
      message: "Concurrent request modified channel state",
    };
  }

  const skipExtra: BatchSettlementPaymentResponseExtra = {
    channelState: channelStateExtra(outcome.current, outcome.current.chargedCumulativeAmount),
    chargedAmount: requirements.amount,
  };

  return {
    skip: true,
    result: {
      success: true,
      payer: outcome.previous.channelConfig.payer.toLowerCase() as `0x${string}`,
      transaction: "",
      network: requirements.network,
      amount: "",
      extra: skipExtra,
    },
  };
}

/**
 * Enriches cooperative refund vouchers with facilitator settlement fields.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage and signer access.
 * @param ctx - Settlement context for the current payment.
 * @returns Additive refund settlement fields, or nothing for non-refund payloads.
 */
export async function handleEnrichSettlementPayload(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
): Promise<Record<string, unknown> | void> {
  const { paymentPayload, requirements } = ctx;
  const raw = paymentPayload.payload;
  if (!isBatchSettlementRefundPayload(raw)) {
    return;
  }

  const channelId = computeChannelId(raw.channelConfig, requirements.network);
  if (raw.voucher.channelId !== channelId) {
    throw new Error("refund channelId does not match channelConfig");
  }

  const requestContext = scheme.readRequestContext(paymentPayload);
  const snapshot = requestContext?.channelSnapshot;
  const stored = await scheme.getStorage().get(channelId);
  const channel: Channel | undefined = snapshot
    ? {
        ...(stored ?? snapshot),
        ...snapshot,
        chargedCumulativeAmount:
          stored?.chargedCumulativeAmount ?? snapshot.chargedCumulativeAmount,
      }
    : stored;
  if (!channel) {
    throw new Error(Errors.ErrMissingChannel);
  }
  const pendingId = requestContext?.pendingId;
  if (await heldByOther(scheme, channelId, pendingId)) {
    throw new Error(Errors.ErrChannelBusy);
  }
  if (BigInt(raw.voucher.maxClaimableAmount) !== BigInt(channel.chargedCumulativeAmount)) {
    throw new Error(Errors.ErrCumulativeAmountMismatch);
  }
  if (raw.voucher.signature !== channel.signature) {
    throw new Error(Errors.ErrInvalidVoucherSignature);
  }

  const config = raw.channelConfig;

  const claimEntry: BatchSettlementVoucherClaim = {
    voucher: {
      channel: config,
      maxClaimableAmount: raw.voucher.maxClaimableAmount,
    },
    signature: raw.voucher.signature,
    totalClaimed: channel.chargedCumulativeAmount,
  };

  const remainder = BigInt(channel.balance) - BigInt(channel.chargedCumulativeAmount);
  if (remainder <= 0n) {
    throw new Error(Errors.ErrRefundNoBalance);
  }

  let refundAmountBig = remainder;
  if (raw.amount !== undefined) {
    if (!/^\d+$/.test(raw.amount)) {
      throw new Error(Errors.ErrRefundAmountInvalid);
    }
    const requested = BigInt(raw.amount);
    if (requested <= 0n) {
      throw new Error(Errors.ErrRefundAmountInvalid);
    }
    refundAmountBig = requested;
  }

  const refundAmount = refundAmountBig.toString();
  const nonce = String(channel.refundNonce ?? 0);

  const receiverAuthorizerSigner = scheme.getReceiverAuthorizerSigner();

  const refundAuthorizerSignature = receiverAuthorizerSigner
    ? await signRefund(
        receiverAuthorizerSigner,
        channelId as `0x${string}`,
        refundAmount,
        nonce,
        requirements.network,
      )
    : undefined;

  const claimAuthorizerSignature = receiverAuthorizerSigner
    ? await signClaimBatch(receiverAuthorizerSigner, [claimEntry], requirements.network)
    : undefined;

  scheme.rememberChannelSnapshot(paymentPayload, channel);

  return {
    ...(raw.amount === undefined ? { amount: refundAmount } : {}),
    refundNonce: nonce,
    claims: [claimEntry],
    refundAuthorizerSignature,
    claimAuthorizerSignature,
  };
}

/**
 * Lifecycle hook: runs after the facilitator settles a payment.
 *
 * Updates channel state to reflect the settlement outcome — adjusting charged amounts,
 * balances, and handling cooperative-refund cleanup (channel record deletion).
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Post-settle lifecycle context.
 * @param ctx.paymentPayload - Payment payload that was settled (possibly rewritten).
 * @param ctx.requirements - Requirements used for settlement.
 * @param ctx.result - Facilitator settle response.
 * @returns Resolves when session updates are complete (no return value).
 */
export async function handleAfterSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<void> {
  const { paymentPayload, requirements, result } = ctx;
  if (!result.success) {
    return;
  }

  const raw = paymentPayload.payload;
  const storage = scheme.getStorage();

  if (isBatchSettlementRefundPayload(raw)) {
    const channelId = computeChannelId(raw.channelConfig, requirements.network);
    const pendingId = scheme.readRequestContext(paymentPayload)?.pendingId;
    const now = Date.now();

    const snapshot = parseRefundSettlementSnapshot(result.extra);
    const recovered = scheme.readRequestContext(paymentPayload)?.channelSnapshot;
    if (await heldByOther(scheme, channelId, pendingId)) {
      throw new Error(Errors.ErrChannelBusy);
    }
    const updateResult = await storage.updateChannel(channelId, current => {
      const existing = current ?? recovered;
      if (!existing) {
        return current;
      }
      if (BigInt(snapshot.balance) <= BigInt(existing.chargedCumulativeAmount)) {
        return undefined;
      }
      return {
        ...existing,
        ...snapshot,
        onchainSyncedAt: now,
        lastRequestTimestamp: now,
      };
    });
    if (updateResult.status === "unchanged") {
      throw new Error(Errors.ErrChannelBusy);
    }
    await scheme.clearPendingRequest(paymentPayload);
    if (!updateResult.channel) {
      return;
    }
    return;
  }

  if (isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  if (isBatchSettlementDepositPayload(raw)) {
    const channelId = raw.voucher.channelId;
    const pendingId = scheme.readRequestContext(paymentPayload)?.pendingId;
    const ex = result.extra ?? {};
    const channelState = readChannelStateExtra(ex);
    const config = raw.channelConfig;
    const signedMaxClaimable = raw.voucher.maxClaimableAmount;
    const now = Date.now();

    if (await heldByOther(scheme, channelId, pendingId)) {
      throw new Error(Errors.ErrChannelBusy);
    }
    const recovered = scheme.readRequestContext(paymentPayload)?.channelSnapshot;
    const updateResult = await storage.updateChannel(channelId, current => {
      const existing = current ?? recovered;
      if (!existing) {
        return current;
      }
      const chargedActual = (
        BigInt(existing.chargedCumulativeAmount) + BigInt(requirements.amount)
      ).toString();
      return {
        channelId,
        channelConfig: config,
        chargedCumulativeAmount: chargedActual,
        signedMaxClaimable,
        signature: raw.voucher.signature,
        balance: readExtraString(channelState, "balance", existing.balance),
        totalClaimed: readExtraString(channelState, "totalClaimed", existing.totalClaimed),
        withdrawRequestedAt: readExtraNumber(
          channelState,
          "withdrawRequestedAt",
          existing.withdrawRequestedAt,
        ),
        refundNonce: readExtraNumber(channelState, "refundNonce", existing.refundNonce),
        onchainSyncedAt: now,
        lastRequestTimestamp: now,
      };
    });
    if (updateResult.status === "updated" && updateResult.channel) {
      scheme.rememberChannelSnapshot(paymentPayload, updateResult.channel);
      await scheme.clearPendingRequest(paymentPayload);
      return;
    }
    throw new Error(Errors.ErrChannelBusy);
  }
}

/**
 * Cleanup hook: clears this request's reservation after settlement throws.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance.
 * @param ctx - Settle failure context for the current payment.
 */
export async function handleSettleFailure(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleFailureContext,
): Promise<void> {
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Supplies server-owned settlement response fields from the channel snapshot.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for snapshot access.
 * @param ctx - Settlement result context for the current payment.
 * @returns Additive response extra fields, or nothing when no snapshot exists.
 */
export async function handleEnrichSettlementResponse(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<Record<string, unknown> | void> {
  const raw = ctx.paymentPayload.payload;
  if (isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const channel = scheme.takeChannelSnapshot(ctx.paymentPayload);
  if (!channel) {
    return;
  }

  if (isBatchSettlementRefundPayload(raw)) {
    return {
      channelState: {
        chargedCumulativeAmount: channel.chargedCumulativeAmount,
      },
    };
  }

  if (isBatchSettlementDepositPayload(raw)) {
    return {
      channelState: {
        chargedCumulativeAmount: channel.chargedCumulativeAmount,
      },
      chargedAmount: ctx.requirements.amount,
    };
  }
  return {
    channelState: {
      chargedCumulativeAmount: channel.chargedCumulativeAmount,
    },
  };
}
