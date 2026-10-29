import type { SettleResponse } from "@x402/core/types";
import { AfterSettleAbortError } from "@x402/core/server";
import type { SettleContext, SettleFailureContext, SettleResultContext } from "@x402/core/server";
import { signClaimBatch, signRefund } from "../authorizerSigner";
import {
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import type { BatchSettlementVoucherClaim } from "../types";
import { computeChannelId } from "../utils";
import * as Errors from "../errors";
import { channelStateExtra, commitVoucherCharge, paymentResponseExtra } from "../voucherStore";
import type { AuthorizerSigner } from "../types";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import { rethrowLockImplementationError } from "./storage";
import {
  parseRefundSettlementSnapshot,
  readChannelStateExtra,
  readExtraNumber,
  readExtraString,
} from "./utils";

type AdmissionHold = "self" | "other" | "none";

/**
 * Inspects the admission lock for this request.
 *
 * Used for deposit/refund holder checks and snapshot recovery. This request
 * proceeds when it holds the lock or no lock is present (lost/expired).
 * Lock-store I/O failures are optimistic (`none`). Implementation/parse
 * errors fail closed and propagate to the caller.
 *
 * @param scheme - Owning scheme for lock-store access.
 * @param channelId - Channel to inspect.
 * @param pendingId - This request's lock owner, if any.
 * @returns `self` when `pendingId` holds; `other` when a different holder is live; `none` otherwise.
 */
async function inspectAdmission(
  scheme: BatchSettlementEvmScheme,
  channelId: string,
  pendingId: string | undefined,
): Promise<AdmissionHold> {
  try {
    const locks = scheme.getLockStorage();
    if (!locks) {
      return "none";
    }
    if (pendingId && (await locks.isHeld(channelId, pendingId))) {
      return "self";
    }
    return (await locks.isHeld(channelId)) ? "other" : "none";
  } catch (err) {
    rethrowLockImplementationError(err);
    return "none";
  }
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
  let outcome = await commitVoucherCharge(storage, channelId, {
    increment,
    signedCap,
    voucher,
    snapshot,
    recoverFromSnapshot: false,
    now,
    localVerify,
  });
  if (
    outcome.status === "missing" &&
    snapshot &&
    (await inspectAdmission(scheme, channelId, requestContext?.pendingId)) === "self"
  ) {
    outcome = await commitVoucherCharge(storage, channelId, {
      increment,
      signedCap,
      voucher,
      snapshot,
      now,
      localVerify,
    });
  }

  await scheme.clearPendingRequest(paymentPayload);

  if (outcome.status === "missing") {
    return {
      abort: true,
      reason: Errors.ErrMissingChannel,
      message: "No channel record",
    };
  }

  if (outcome.status === "cap_exceeded") {
    return {
      abort: true,
      reason: Errors.ErrChargeExceedsSignedCumulative,
      message: `Charged ${outcome.charged} exceeds signed max ${signedCap.toString()}`,
    };
  }

  if (outcome.status !== "committed") {
    return {
      abort: true,
      reason: Errors.ErrChannelBusy,
      message: "Concurrent request modified channel state",
    };
  }

  const skipExtra = paymentResponseExtra({
    channelState: channelStateExtra(outcome.current, outcome.current.chargedCumulativeAmount),
    chargedAmount: requirements.amount,
  });

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
  const pendingId = requestContext?.pendingId;
  const hold = await inspectAdmission(scheme, channelId, pendingId);
  if (!stored && snapshot && hold !== "self") {
    throw new Error(Errors.ErrMissingChannel);
  }
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
  if (hold === "other") {
    throw new Error(Errors.ErrChannelBusy);
  }
  if (BigInt(raw.voucher.maxClaimableAmount) !== BigInt(channel.chargedCumulativeAmount)) {
    throw new Error(Errors.ErrCumulativeAmountMismatch);
  }
  if (raw.voucher.signature !== channel.signature) {
    throw new Error(Errors.ErrInvalidVoucherSignature);
  }

  const fields = await buildRefundSettlementFields({
    channel,
    raw,
    channelId,
    network: requirements.network,
    refundSigner: scheme.getReceiverAuthorizerSigner(),
    includeClaimAuthorizerSignature: true,
  });

  scheme.rememberChannelSnapshot(paymentPayload, channel);
  return fields;
}

/**
 * Builds facilitator settlement fields for a cooperative refund.
 *
 * @param opts - Refund channel, payload, signer, and signature options.
 * @param opts.channel - Stored channel snapshot.
 * @param opts.raw - Refund payload.
 * @param opts.raw.channelConfig - Channel config for the claim entry.
 * @param opts.raw.voucher - Zero-charge refund voucher.
 * @param opts.raw.voucher.maxClaimableAmount - Signed cumulative ceiling.
 * @param opts.raw.voucher.signature - Client voucher signature.
 * @param opts.raw.amount - Optional requested refund amount.
 * @param opts.channelId - Canonical channel id.
 * @param opts.network - CAIP-2 network for EIP-712 signatures.
 * @param opts.refundSigner - Optional refund authorizer.
 * @param opts.includeClaimAuthorizerSignature - Whether to sign the claim batch.
 * @returns Additive refund settlement fields.
 */
export async function buildRefundSettlementFields(opts: {
  channel: Channel;
  raw: {
    channelConfig: Channel["channelConfig"];
    voucher: { maxClaimableAmount: string; signature: `0x${string}` };
    amount?: string;
  };
  channelId: string;
  network: string;
  refundSigner?: AuthorizerSigner;
  includeClaimAuthorizerSignature: boolean;
}): Promise<Record<string, unknown>> {
  const claimEntry: BatchSettlementVoucherClaim = {
    voucher: {
      channel: opts.raw.channelConfig,
      maxClaimableAmount: opts.raw.voucher.maxClaimableAmount,
    },
    signature: opts.raw.voucher.signature,
    totalClaimed: opts.channel.chargedCumulativeAmount,
  };

  const remainder = BigInt(opts.channel.balance) - BigInt(opts.channel.chargedCumulativeAmount);
  if (remainder <= 0n) {
    throw new Error(Errors.ErrRefundNoBalance);
  }

  let refundAmountBig = remainder;
  if (opts.raw.amount !== undefined) {
    if (!/^\d+$/.test(opts.raw.amount)) {
      throw new Error(Errors.ErrRefundAmountInvalid);
    }
    const requested = BigInt(opts.raw.amount);
    if (requested <= 0n) {
      throw new Error(Errors.ErrRefundAmountInvalid);
    }
    refundAmountBig = requested;
  }

  const refundAmount = refundAmountBig.toString();
  const nonce = String(opts.channel.refundNonce ?? 0);

  const refundAuthorizerSignature = opts.refundSigner
    ? await signRefund(
        opts.refundSigner,
        opts.channelId as `0x${string}`,
        refundAmount,
        nonce,
        opts.network,
      )
    : undefined;

  const claimAuthorizerSignature =
    opts.includeClaimAuthorizerSignature && opts.refundSigner
      ? await signClaimBatch(opts.refundSigner, [claimEntry], opts.network)
      : undefined;

  return {
    ...(opts.raw.amount === undefined ? { amount: refundAmount } : {}),
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
 * A self-managed deposit persist failure throws {@link AfterSettleAbortError} so core
 * flips the onchain success to `success: false` without releasing the resource.
 * Refund persist failures throw a plain error (logged and ignored by core).
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Post-settle lifecycle context.
 * @param ctx.paymentPayload - Payment payload that was settled (possibly rewritten).
 * @param ctx.requirements - Requirements used for settlement.
 * @param ctx.result - Facilitator settle response.
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
    const hold = await inspectAdmission(scheme, channelId, pendingId);
    if (hold === "other") {
      throw new Error(Errors.ErrChannelBusy);
    }
    try {
      const updateResult = await storage.updateChannel(channelId, current => {
        const existing = current ?? (hold === "self" ? recovered : undefined);
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
      switch (updateResult.status) {
        case "updated":
        case "deleted":
          break;
        case "unchanged":
        case "conflict":
          throw new Error(Errors.ErrChannelBusy);
        default: {
          const exhaustive: never = updateResult.status;
          throw exhaustive;
        }
      }
    } finally {
      if (hold === "self") {
        await scheme.releasePendingRequest(paymentPayload);
      }
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

    const hold = await inspectAdmission(scheme, channelId, pendingId);
    if (hold === "other") {
      throw new AfterSettleAbortError(Errors.ErrChannelBusy);
    }
    const recovered = scheme.readRequestContext(paymentPayload)?.channelSnapshot;
    let missingRow = false;
    let abortReason: string | undefined;
    let abortMessage: string | undefined;
    try {
      const updateResult = await storage.updateChannel(channelId, current => {
        const existing = current ?? (hold === "self" ? recovered : undefined);
        if (!existing) {
          missingRow = missingRow || current === undefined;
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
      switch (updateResult.status) {
        case "updated":
          if (updateResult.channel) {
            scheme.rememberChannelSnapshot(paymentPayload, updateResult.channel);
          } else {
            abortReason = Errors.ErrChannelBusy;
          }
          break;
        case "unchanged":
        case "conflict":
        case "deleted":
          abortReason = missingRow ? Errors.ErrMissingChannel : Errors.ErrChannelBusy;
          break;
        default: {
          const exhaustive: never = updateResult.status;
          throw exhaustive;
        }
      }
    } catch (err) {
      rethrowLockImplementationError(err);
      abortReason = Errors.ErrVoucherStoreUnavailable;
      abortMessage = err instanceof Error ? err.message : String(err);
    } finally {
      if (hold === "self") {
        await scheme.releasePendingRequest(paymentPayload);
      }
    }
    if (abortReason) {
      throw new AfterSettleAbortError(abortReason, abortMessage);
    }
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
