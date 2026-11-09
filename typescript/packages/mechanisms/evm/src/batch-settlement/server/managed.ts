import type {
  SettleContext,
  SettleFailureContext,
  SettleResultContext,
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyResultContext,
} from "@x402/core/server";
import type { Network, PaymentRequirements, SchemePaymentRequiredContext } from "@x402/core/types";
import { isBatchSettlementPayload, isBatchSettlementRefundPayload } from "../types";
import type {
  BatchSettlementChannelStateExtra,
  BatchSettlementPayload,
  BatchSettlementVoucherStateExtra,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import * as Errors from "../errors";
import { requestContextTtlMs } from "../voucherStore";
import type { Channel } from "./storage";
import {
  abortIfBelowMinDeposit,
  abortIfChannelUnbound,
  abortIfUnexpectedServerAuthoredSettleFields,
  skipHandlerForRefund,
  verificationStateUnavailable,
  writeCorrectiveAcceptExtra,
} from "./verify";
import { buildRefundSettlementFields } from "./settle";
import { readChannelStateExtra, readExtraUintString } from "./utils";
import type { BatchSettlementEvmScheme } from "./scheme";

type ManagedChannelState = Pick<
  Channel,
  | "chargedCumulativeAmount"
  | "balance"
  | "totalClaimed"
  | "withdrawRequestedAt"
  | "refundNonce"
  | "network"
>;

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
      const channelState = readChannelStateExtra(ex) as
        | BatchSettlementChannelStateExtra
        | undefined;
      const voucherValue = ex.voucherState;
      const voucherState =
        typeof voucherValue === "object" && voucherValue !== null
          ? (voucherValue as BatchSettlementVoucherStateExtra)
          : undefined;
      if (channelState || voucherState) {
        scheme.mergeRequestContext(
          paymentPayload,
          {
            correctiveChannelState: channelState,
            correctiveVoucherState: voucherState,
          },
          requestContextTtlMs(ctx.requirements.maxTimeoutSeconds),
        );
      }
    }
    return;
  }

  const ex = result.extra ?? {};
  const pendingId = readPendingId(ex);
  if (!pendingId) {
    return verificationStateUnavailable();
  }

  scheme.mergeRequestContext(
    paymentPayload,
    {
      channelId: raw.voucher.channelId,
      pendingId,
      reservationCommitted: true,
    },
    requestContextTtlMs(ctx.requirements.maxTimeoutSeconds),
  );

  const state = parseManagedChannelState(ex);
  if (!state) {
    return verificationStateUnavailable();
  }

  scheme.mergeRequestContext(paymentPayload, {
    channelSnapshot: toChannelView(raw, state, ctx.requirements.network),
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
 * @param scheme - Owning scheme.
 * @param ctx - Cancellation context from the resource server.
 * @returns Zero-amount requirements for batch-settlement payloads; void otherwise.
 */
export function handleManagedSettleOnCancel(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifiedPaymentCanceledContext,
): PaymentRequirements | void {
  if (
    ctx.reason !== "handler_failed" &&
    ctx.reason !== "handler_threw" &&
    ctx.reason !== "after_verify_aborted" &&
    ctx.reason !== "settlement_preflight_failed"
  ) {
    return;
  }
  if (!isBatchSettlementPayload(ctx.paymentPayload.payload)) {
    return;
  }

  const requestContext = scheme.readRequestContext(ctx.paymentPayload);
  if (!requestContext?.pendingId) {
    const verifiedPendingId = readPendingId(ctx.verifyResult?.extra);
    if (!verifiedPendingId) {
      scheme.takeRequestContext(ctx.paymentPayload);
      return;
    }
    scheme.mergeRequestContext(
      ctx.paymentPayload,
      { pendingId: verifiedPendingId },
      requestContextTtlMs(ctx.requirements.maxTimeoutSeconds),
    );
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
 * Not read on the hot path.
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
  const isRefund = isBatchSettlementRefundPayload(raw);
  const replicaState = managedReplicaState(scheme, ctx, isRefund);
  if (!replicaState) {
    return;
  }

  const state = toChannelView(raw, replicaState, ctx.requirements.network);
  if (isRefund && BigInt(state.balance) <= BigInt(state.chargedCumulativeAmount)) {
    await storage.updateChannel(channelId, current => (current ? undefined : current));
    return;
  }

  await storage.updateChannel(channelId, current => {
    if (current && !isRefund) {
      try {
        if (BigInt(state.chargedCumulativeAmount) < BigInt(current.chargedCumulativeAmount)) {
          return current;
        }
      } catch {
        // Non-numeric watermarks fall through to the normal upsert below.
      }
    }
    return { ...state, network: state.network || current?.network };
  });
}

/**
 * Resolves the channel state to replicate.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Post-settle context.
 * @param isRefund - Whether the payload is a cooperative refund.
 * @returns Trusted channel state, or undefined when none is available.
 */
function managedReplicaState(
  scheme: BatchSettlementEvmScheme,
  ctx: SettleResultContext,
  isRefund: boolean,
): ManagedChannelState | undefined {
  const settled = parseManagedChannelState(readChannelStateExtra(ctx.result.extra));
  if (settled || isRefund) {
    return settled;
  }
  return scheme.readRequestContext(ctx.paymentPayload)?.channelSnapshot;
}

/**
 * Builds a channel view from parsed state.
 *
 * @param raw - Batch-settlement payload being verified or settled.
 * @param state - Trusted facilitator channel state.
 * @param network - Network from the request requirements.
 * @returns Complete channel view.
 */
function toChannelView(
  raw: BatchSettlementPayload,
  state: ManagedChannelState,
  network: Network,
): Channel {
  return {
    ...state,
    network: network || state.network,
    channelId: raw.voucher.channelId,
    channelConfig: raw.channelConfig,
    signedMaxClaimable: raw.voucher.maxClaimableAmount,
    signature: raw.voucher.signature,
    lastRequestTimestamp: Date.now(),
  };
}

/**
 * Strictly parses channel state.
 *
 * @param extra - Facilitator verify or settle extras.
 * @returns Strictly parsed channel state, or undefined when a field is missing or malformed.
 */
function parseManagedChannelState(
  extra: Partial<Record<keyof BatchSettlementChannelStateExtra, unknown>> | undefined,
): ManagedChannelState | undefined {
  const chargedCumulativeAmount = readExtraUintString(extra, "chargedCumulativeAmount");
  const balance = readExtraUintString(extra, "balance");
  const totalClaimed = readExtraUintString(extra, "totalClaimed");
  const withdrawRequestedAt = readExtraUintString(extra, "withdrawRequestedAt");
  const refundNonce = readExtraUintString(extra, "refundNonce");
  if (
    chargedCumulativeAmount === undefined ||
    balance === undefined ||
    totalClaimed === undefined ||
    withdrawRequestedAt === undefined ||
    refundNonce === undefined
  ) {
    return undefined;
  }

  const withdrawRequestedAtNumber = Number(withdrawRequestedAt);
  const refundNonceNumber = Number(refundNonce);
  if (
    !Number.isSafeInteger(withdrawRequestedAtNumber) ||
    !Number.isSafeInteger(refundNonceNumber)
  ) {
    return undefined;
  }

  return {
    chargedCumulativeAmount,
    balance,
    totalClaimed,
    withdrawRequestedAt: withdrawRequestedAtNumber,
    refundNonce: refundNonceNumber,
  };
}

/**
 * Reads `pendingId` from verify extras.
 *
 * @param extra - Facilitator verify extras.
 * @returns The non-empty `pendingId`, or undefined.
 */
function readPendingId(extra: Record<string, unknown> | undefined): string | undefined {
  const value = extra?.pendingId;
  return typeof value === "string" && value ? value : undefined;
}
