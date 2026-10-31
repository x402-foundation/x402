import type {
  SettleContext,
  SettleFailureContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyResultContext,
} from "@x402/core/server";
import type { PaymentRequirements, SchemePaymentRequiredContext } from "@x402/core/types";
import { isBatchSettlementPayload, isBatchSettlementRefundPayload } from "../types";
import type { BatchSettlementChannelStateExtra, BatchSettlementVoucherStateExtra } from "../types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import * as Errors from "../errors";
import type { Channel } from "./storage";
import {
  abortIfBelowMinDeposit,
  abortIfChannelUnbound,
  abortIfUnexpectedServerAuthoredSettleFields,
  skipHandlerForRefund,
  writeCorrectiveAcceptExtra,
} from "./verify";
import { buildRefundSettlementFields } from "./settle";
import { readChannelStateExtra, readExtraNumber, readExtraString } from "./utils";
import type { BatchSettlementEvmScheme } from "./scheme";

/**
 * Pass-through verify: min-deposit + channel-id binding only.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Verify lifecycle context.
 * @returns Abort on binding/min-deposit failure; otherwise continue to facilitator `/verify`.
 */
export async function handleManagedBeforeVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyContext,
): Promise<void | { abort: true; reason: string; message?: string }> {
  const { paymentPayload, requirements } = ctx;
  const raw = paymentPayload.payload;
  if (!isBatchSettlementPayload(raw)) {
    return;
  }

  const serverFieldAbort = abortIfUnexpectedServerAuthoredSettleFields(raw);
  if (serverFieldAbort) {
    return serverFieldAbort;
  }

  const minDepositAbort = await abortIfBelowMinDeposit(scheme, raw, requirements);
  if (minDepositAbort) {
    return minDepositAbort;
  }

  return abortIfChannelUnbound(raw, requirements.network);
}

/**
 * True when a verify rejection carries a resyncable cumulative baseline.
 * The facilitator emits `ErrCumulativeAmountMismatch` for managed
 * voucher-store drift, while the shared client handshake also accepts
 * `ErrCumulativeAmountBelowClaimed`; the server must propagate corrective
 * extras for both or the client falls back to stale onchain recovery.
 *
 * @param reason - Facilitator verify rejection reason, when present.
 * @returns Whether the server should attach corrective cumulative baseline extras.
 */
function isCorrectiveMismatch(reason: string | undefined): boolean {
  return (
    reason === Errors.ErrCumulativeAmountMismatch ||
    reason === Errors.ErrCumulativeAmountBelowClaimed
  );
}

/**
 * After facilitator verify: stash a channel view for refund enrichment / replica,
 * or stash corrective extras. Refunds skip the resource handler.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Post-verify context.
 * @returns `skipHandler` for refunds; otherwise void.
 */
export async function handleManagedAfterVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyResultContext,
): Promise<
  | void
  | { skipHandler: true; response?: { contentType?: string; body?: unknown } }
  | { abort: true; reason: string; message?: string }
> {
  const { paymentPayload, result } = ctx;
  const raw = paymentPayload.payload;
  if (!isBatchSettlementPayload(raw)) {
    return;
  }

  if (!result.isValid) {
    if (isCorrectiveMismatch(result.invalidReason)) {
      const ex = result.extra ?? {};
      const channelState = readCorrectiveChannelState(ex);
      const voucherState = readCorrectiveVoucherState(ex);
      if (channelState || voucherState) {
        scheme.mergeRequestContext(paymentPayload, {
          correctiveChannelState: channelState,
          correctiveVoucherState: voucherState,
        });
      }
    }
    return;
  }

  const ex = result.extra ?? {};
  const now = Date.now();
  const channelSnapshot: Channel = {
    channelId: raw.voucher.channelId,
    channelConfig: raw.channelConfig,
    chargedCumulativeAmount: readExtraString(ex, "chargedCumulativeAmount", "0"),
    signedMaxClaimable: raw.voucher.maxClaimableAmount,
    signature: raw.voucher.signature,
    balance: readExtraString(ex, "balance", "0"),
    totalClaimed: readExtraString(ex, "totalClaimed", "0"),
    withdrawRequestedAt: readExtraNumber(ex, "withdrawRequestedAt", 0),
    refundNonce: readExtraNumber(ex, "refundNonce", 0),
    lastRequestTimestamp: now,
  };

  const pendingId = typeof ex.pendingId === "string" && ex.pendingId ? ex.pendingId : undefined;

  scheme.mergeRequestContext(paymentPayload, {
    channelId: raw.voucher.channelId,
    channelSnapshot,
    ...(pendingId ? { pendingId, reservationCommitted: true } : {}),
  });

  if (isBatchSettlementRefundPayload(raw)) {
    return skipHandlerForRefund(raw.voucher.channelId);
  }
}

/**
 * Copies facilitator-supplied corrective extras onto the matching 402 accept.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Payment-required response context.
 */
export async function handleManagedEnrichPaymentRequiredResponse(
  scheme: BatchSettlementEvmScheme,
  ctx: SchemePaymentRequiredContext,
): Promise<void> {
  if (!isCorrectiveMismatch(ctx.error) || !ctx.paymentPayload) {
    return;
  }

  const requestContext = scheme.takeRequestContext(ctx.paymentPayload);
  const channelState = requestContext?.correctiveChannelState;
  const voucherState = requestContext?.correctiveVoucherState;
  if (!channelState || !voucherState) {
    return;
  }

  for (const accept of ctx.requirements) {
    if (
      accept.scheme === BATCH_SETTLEMENT_SCHEME &&
      accept.network === ctx.paymentPayload.accepted.network
    ) {
      writeCorrectiveAcceptExtra(accept, channelState, voucherState);
    }
  }
}

/** Managed mode has no local admission lock or settle short-circuit. */
async function noopManagedHook(): Promise<void> {}

export const handleManagedBeforeSettle = noopManagedHook;
export const handleManagedEnrichSettlementResponse = noopManagedHook;
export const handleManagedVerifyFailure = noopManagedHook;
export const handleManagedVerifiedPaymentCanceled = noopManagedHook;

/**
 * Drops the stashed request context after a failed settle. The facilitator owns the
 * admission lock, so there is nothing else to release locally.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Settle failure context.
 */
export async function handleManagedSettleFailure(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleFailureContext,
): Promise<void> {
  scheme.takeRequestContext(ctx.paymentPayload);
}

/**
 * Settles a cancel so the facilitator can drop the admission lock.
 * Enrichment stamps `cancel: true`; the facilitator must not charge, deposit,
 * or refund.
 *
 * @param ctx - Cancellation context from the resource server.
 * @returns Zero-amount requirements for batch-settlement payloads; void otherwise.
 */
export function handleManagedSettleOnCancel(
  ctx: VerifiedPaymentCanceledContext,
): PaymentRequirements | void {
  if (
    ctx.reason !== "handler_failed" &&
    ctx.reason !== "handler_threw" &&
    ctx.reason !== "after_verify_aborted"
  ) {
    return;
  }
  if (!isBatchSettlementPayload(ctx.paymentPayload.payload)) {
    return;
  }
  return { ...ctx.requirements, amount: "0" };
}

/**
 * Echoes verify `pendingId` onto `/settle` and completes a managed refund.
 * Cancel stamps `cancel: true` so the facilitator only releases the lock.
 * Never sets `claimAuthorizerSignature`.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Settlement context.
 * @returns Additive settle fields, or nothing when there is nothing to attach.
 */
export async function handleManagedEnrichSettlementPayload(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleContext,
): Promise<Record<string, unknown> | void> {
  const { paymentPayload, requirements } = ctx;
  const raw = paymentPayload.payload;
  if (!isBatchSettlementPayload(raw)) {
    return;
  }

  const pendingId = scheme.readRequestContext(paymentPayload)?.pendingId;
  const pendingFields = pendingId ? { pendingId } : {};

  if (ctx.phase === "cancel") {
    return { ...pendingFields, cancel: true };
  }

  if (isBatchSettlementRefundPayload(raw)) {
    const snapshot = scheme.readRequestContext(paymentPayload)?.channelSnapshot;
    if (!snapshot) {
      throw new Error(Errors.ErrMissingChannel);
    }

    try {
      return {
        ...(await buildRefundSettlementFields({
          channel: snapshot,
          raw,
          channelId: raw.voucher.channelId,
          network: requirements.network,
          refundSigner: scheme.getRefundAuthorizerSigner(),
          includeClaimAuthorizerSignature: false,
        })),
        ...pendingFields,
      };
    } catch (error) {
      scheme.takeRequestContext(paymentPayload);
      throw error;
    }
  }

  return pendingId ? pendingFields : undefined;
}

/**
 * Replica upsert after a successful managed settle, then drops the request context.
 * Every managed settle is terminal, so the context is released on all paths.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Post-settle context.
 */
export async function handleManagedAfterSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<void> {
  try {
    await upsertReplicaAfterSettle(scheme, ctx);
  } finally {
    scheme.takeRequestContext(ctx.paymentPayload);
  }
}

/**
 * Replica upsert after a successful managed settle. Not read on the hot path.
 * Cancel settles leave the replica watermark unchanged, so this is a no-op.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Post-settle context.
 */
async function upsertReplicaAfterSettle(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
): Promise<void> {
  const { paymentPayload, result } = ctx;
  if (!result.success || ctx.phase === "cancel") {
    return;
  }

  const raw = paymentPayload.payload;
  if (!isBatchSettlementPayload(raw)) {
    return;
  }

  const storage = scheme.getStorage();
  const channelId = raw.voucher.channelId;
  const channelState = readChannelStateExtra(result.extra);
  const now = Date.now();
  const charged =
    (channelState && readExtraString(channelState, "chargedCumulativeAmount", "")) ||
    scheme.readRequestContext(paymentPayload)?.channelSnapshot?.chargedCumulativeAmount ||
    "0";

  if (isBatchSettlementRefundPayload(raw)) {
    const balance = readExtraString(channelState, "balance", "0");
    if (BigInt(balance) <= BigInt(charged)) {
      await storage.updateChannel(channelId, current => (current ? undefined : current));
      return;
    }
  }

  await storage.updateChannel(channelId, current => {
    if (current && !isBatchSettlementRefundPayload(raw)) {
      try {
        if (BigInt(charged) < BigInt(current.chargedCumulativeAmount)) {
          return current;
        }
      } catch {
        // Non-numeric watermarks fall through to the normal upsert below.
      }
    }
    const base = current ?? scheme.readRequestContext(paymentPayload)?.channelSnapshot;
    return {
      channelId,
      channelConfig: raw.channelConfig,
      chargedCumulativeAmount: charged || base?.chargedCumulativeAmount || "0",
      signedMaxClaimable: raw.voucher.maxClaimableAmount,
      signature: raw.voucher.signature,
      balance: readExtraString(channelState, "balance", base?.balance ?? "0"),
      totalClaimed: readExtraString(channelState, "totalClaimed", base?.totalClaimed ?? "0"),
      withdrawRequestedAt: readExtraNumber(
        channelState,
        "withdrawRequestedAt",
        base?.withdrawRequestedAt ?? 0,
      ),
      refundNonce: readExtraNumber(channelState, "refundNonce", base?.refundNonce ?? 0),
      lastRequestTimestamp: now,
    };
  });
}

/**
 * Reads typed channel state from facilitator extras.
 *
 * @param extra - Facilitator response extras.
 * @returns Channel state or undefined.
 */
function readCorrectiveChannelState(
  extra: Record<string, unknown>,
): BatchSettlementChannelStateExtra | undefined {
  const value = extra.channelState;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as BatchSettlementChannelStateExtra;
}

/**
 * Reads typed voucher state from facilitator extras.
 *
 * @param extra - Facilitator response extras.
 * @returns Voucher state or undefined.
 */
function readCorrectiveVoucherState(
  extra: Record<string, unknown>,
): BatchSettlementVoucherStateExtra | undefined {
  const value = extra.voucherState;
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  return value as BatchSettlementVoucherStateExtra;
}
