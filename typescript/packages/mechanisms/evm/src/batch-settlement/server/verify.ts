import type {
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
  VerifyResultContext,
} from "@x402/core/server";
import type { VerifyResponse } from "@x402/core/types";
import type { SchemePaymentRequiredContext } from "@x402/core/types";
import { getAddress, verifyTypedData } from "viem";
import {
  type BatchSettlementDepositPayload,
  type BatchSettlementRefundPayload,
  type BatchSettlementVoucherPayload,
  isBatchSettlementDepositPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME, voucherTypes } from "../constants";
import type { ChannelConfig } from "../types";
import { createNonce, getEvmChainId } from "../../utils";
import { computeChannelId, getBatchSettlementEip712Domain } from "../utils";
import { validateChannelConfig } from "../facilitator/utils";
import * as Errors from "../errors";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel, PendingRequest } from "./storage";
import { readExtraNumber, readExtraString } from "./utils";

// Framework cleanup hooks clear pending reservations for normal failures
// This bounded TTL releases channels when cleanup cannot run or complete
const MIN_PENDING_TTL_MS = 5_000; // 5 seconds
const MAX_PENDING_TTL_MS = 10 * 60 * 1000; // 600 seconds

/**
 * Computes the bounded pending reservation expiry time.
 *
 * @param maxTimeoutSeconds - Resource timeout from payment requirements.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Expiry timestamp in milliseconds.
 */
function pendingExpiresAt(maxTimeoutSeconds: number | undefined, now: number): number {
  const requestedMs = Math.max(0, maxTimeoutSeconds ?? 0) * 1000;
  const ttlMs = Math.min(MAX_PENDING_TTL_MS, Math.max(MIN_PENDING_TTL_MS, requestedMs));
  return now + ttlMs;
}

/**
 * Checks whether a pending reservation still blocks same-channel work.
 *
 * @param pending - Pending reservation to inspect.
 * @param now - Current wall-clock time in milliseconds.
 * @returns Whether the reservation exists and has not expired.
 */
function isPendingLive(pending: PendingRequest | undefined, now: number): boolean {
  return pending !== undefined && pending.expiresAt > now;
}

/**
 * Lifecycle hook: runs before the facilitator verifies a payment.
 *
 * For paid payloads, checks whether the client's cumulative amount matches server
 * state. If mismatched, aborts with `invalid_batch_settlement_evm_cumulative_amount_mismatch`.
 *
 * Refund vouchers are zero-charge: the expected `maxClaimableAmount` equals
 * the existing `chargedCumulativeAmount`.
 *
 * When no local channel record exists, verification is delegated to the facilitator (which checks onchain state);
 * `handleAfterVerify` then rebuilds the channel record from the verify response.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Verify lifecycle context (payload, requirements, and related state).
 * @returns Nothing to continue verification; or an object with `abort` to fail with a reason.
 */
export async function handleBeforeVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyContext,
): Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: VerifyResponse }
> {
  const { paymentPayload, requirements } = ctx;

  const raw = paymentPayload.payload;
  const isPaidPayload =
    isBatchSettlementVoucherPayload(raw) || isBatchSettlementDepositPayload(raw);
  const isZeroChargePayload = isBatchSettlementRefundPayload(raw);
  if (!isPaidPayload && !isZeroChargePayload) {
    return;
  }

  const channelId = raw.voucher.channelId;
  const now = Date.now();
  const pendingId = createNonce();
  let outcome:
    | { status: "reserved"; channelSnapshot?: Channel }
    | { status: "busy" }
    | { status: "mismatch"; channel: Channel }
    | undefined;

  await scheme.getStorage().updateChannel(channelId, current => {
    if (isPendingLive(current?.pendingRequest, now)) {
      outcome = { status: "busy" };
      return current;
    }

    const chargedCumulativeAmount =
      current?.chargedCumulativeAmount ??
      inferMissingLocalChargedAmount(
        raw.voucher.maxClaimableAmount,
        requirements.amount,
        isPaidPayload,
      );
    const expectedMaxClaimable = isZeroChargePayload
      ? BigInt(chargedCumulativeAmount)
      : BigInt(chargedCumulativeAmount) + BigInt(requirements.amount);

    if (BigInt(raw.voucher.maxClaimableAmount) !== expectedMaxClaimable) {
      if (current) {
        outcome = { status: "mismatch", channel: current };
      } else {
        outcome = {
          status: "mismatch",
          channel: buildProvisionalChannel(raw, chargedCumulativeAmount),
        };
      }
      return current;
    }

    const pendingRequest: PendingRequest = {
      pendingId,
      signedMaxClaimable: raw.voucher.maxClaimableAmount,
      expiresAt: pendingExpiresAt(requirements.maxTimeoutSeconds, now),
    };

    outcome = { status: "reserved", channelSnapshot: current };
    return {
      ...(current ?? buildProvisionalChannel(raw, chargedCumulativeAmount)),
      pendingRequest,
      lastRequestTimestamp: now,
    };
  });

  if (outcome?.status === "busy") {
    return {
      abort: true,
      reason: Errors.ErrChannelBusy,
      message: "Channel is already processing a request",
    };
  }

  if (outcome?.status === "mismatch") {
    scheme.rememberChannelSnapshot(paymentPayload, outcome.channel);
    return {
      abort: true,
      reason: Errors.ErrCumulativeAmountMismatch,
      message: "Client voucher base does not match server state",
    };
  }

  if (outcome?.status === "reserved") {
    scheme.mergeRequestContext(paymentPayload, {
      channelId,
      pendingId,
      channelSnapshot: outcome.channelSnapshot,
    });

    if (isBatchSettlementVoucherPayload(raw)) {
      const localResult = await verifyVoucherLocally(
        scheme,
        raw,
        requirements,
        outcome.channelSnapshot,
        now,
      );
      if (localResult) {
        scheme.mergeRequestContext(paymentPayload, { localVerify: true });
        return { skip: true, result: localResult };
      }
    }
  }
}

/**
 * Adds server channel state to corrective 402 responses for cumulative mismatches.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Payment-required response context.
 */
export async function handleEnrichPaymentRequiredResponse(
  scheme: BatchSettlementEvmScheme,
  ctx: SchemePaymentRequiredContext,
): Promise<void> {
  if (ctx.error !== Errors.ErrCumulativeAmountMismatch) {
    return;
  }

  const { paymentPayload } = ctx;
  if (!paymentPayload) {
    return;
  }

  const raw = paymentPayload.payload;
  if (
    !isBatchSettlementVoucherPayload(raw) &&
    !isBatchSettlementDepositPayload(raw) &&
    !isBatchSettlementRefundPayload(raw)
  ) {
    return;
  }

  const channel =
    scheme.takeChannelSnapshot(paymentPayload) ??
    (await scheme.getStorage().get(raw.voucher.channelId));
  if (!channel) {
    return;
  }

  const accept = ctx.requirements.find(
    req =>
      req.scheme === BATCH_SETTLEMENT_SCHEME && req.network === paymentPayload.accepted.network,
  );
  if (!accept) {
    return;
  }

  accept.extra = {
    ...accept.extra,
    channelState: {
      channelId: channel.channelId,
      balance: channel.balance,
      totalClaimed: channel.totalClaimed,
      withdrawRequestedAt: channel.withdrawRequestedAt,
      refundNonce: String(channel.refundNonce),
      chargedCumulativeAmount: channel.chargedCumulativeAmount,
    },
    voucherState: {
      signedMaxClaimable: channel.signedMaxClaimable,
      signature: channel.signature as `0x${string}`,
    },
  };
}

/**
 * Lifecycle hook: runs after the facilitator verifies a payment.
 *
 * Persists channel state (balance, totalClaimed, voucher info) so that
 * subsequent requests can correctly calculate cumulative amounts and detect stale state.
 *
 * For refund payloads, additionally returns a `skipHandler` directive so that
 * the resource server bypasses the application handler and settles inline.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance for storage access.
 * @param ctx - Post-verify lifecycle context.
 * @param ctx.paymentPayload - Incoming payment payload that was verified.
 * @param ctx.requirements - Requirements used for verification.
 * @param ctx.result - Facilitator verify response.
 * @returns Optional `skipHandler` directive when this is a refund voucher; otherwise void.
 */
export async function handleAfterVerify(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyResultContext,
): Promise<void | { skipHandler: true; response?: { contentType?: string; body?: unknown } }> {
  const { paymentPayload, result } = ctx;
  if (!result.isValid || !result.payer) {
    await scheme.clearPendingRequest(paymentPayload);
    return;
  }

  const raw = paymentPayload.payload;
  let channelId: string;
  let signedMaxClaimable: string;
  let signature: `0x${string}`;
  let channelConfig: ChannelConfig;
  let isRefundVoucher = false;

  if (isBatchSettlementDepositPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
  } else if (isBatchSettlementVoucherPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
  } else if (isBatchSettlementRefundPayload(raw)) {
    channelId = raw.voucher.channelId;
    signedMaxClaimable = raw.voucher.maxClaimableAmount;
    signature = raw.voucher.signature;
    channelConfig = raw.channelConfig;
    isRefundVoucher = true;
  } else {
    return;
  }

  const ex = result.extra ?? {};
  const balance = readExtraString(ex, "balance", "0");
  const totalClaimed = readExtraString(ex, "totalClaimed", "0");
  const withdrawRequestedAt = readExtraNumber(ex, "withdrawRequestedAt", 0);
  const refundNonce = readExtraNumber(ex, "refundNonce", 0);
  const now = Date.now();

  const storage = scheme.getStorage();
  const requestContext = scheme.readRequestContext(paymentPayload);
  if (!requestContext?.pendingId) {
    return;
  }
  if (requestContext.localVerify && isBatchSettlementVoucherPayload(raw)) {
    return;
  }

  const updateResult = await storage.updateChannel(channelId, current => {
    if (!current || current.pendingRequest?.pendingId !== requestContext.pendingId) {
      return current;
    }

    const channel: Channel = {
      channelId,
      channelConfig,
      chargedCumulativeAmount: current.chargedCumulativeAmount,
      signedMaxClaimable,
      signature,
      balance,
      totalClaimed,
      withdrawRequestedAt,
      refundNonce,
      onchainSyncedAt: requestContext.localVerify ? current.onchainSyncedAt : now,
      lastRequestTimestamp: now,
      pendingRequest: current.pendingRequest,
    };
    return channel;
  });
  if (updateResult.status === "updated" && updateResult.channel) {
    scheme.rememberChannelSnapshot(paymentPayload, updateResult.channel);
  }

  if (isRefundVoucher && updateResult.status === "updated") {
    return {
      skipHandler: true,
      response: {
        contentType: "application/json",
        body: { message: "Refund acknowledged", channelId },
      },
    };
  }
}

/**
 * Cleanup hook: clears this request's reservation after verify throws.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance.
 * @param ctx - Verify failure context for the current payment.
 */
export async function handleVerifyFailure(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyFailureContext,
): Promise<void> {
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Cleanup hook: clears this request's reservation when handler work is canceled.
 *
 * @param scheme - Owning `BatchSettlementEvmScheme` instance.
 * @param ctx - Verified-payment cancellation context.
 */
export async function handleVerifiedPaymentCanceled(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifiedPaymentCanceledContext,
): Promise<void> {
  if (ctx.reason !== "handler_threw" && ctx.reason !== "handler_failed") {
    return;
  }
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Verifies a voucher against locally cached channel state when that state is fresh.
 *
 * @param scheme - Batch settlement scheme (TTL for onchain sync freshness).
 * @param raw - Decoded batch-settlement voucher payload.
 * @param requirements - Payment requirements (network, etc.).
 * @param channel - Cached channel row, if any.
 * @param now - Current wall-clock time in milliseconds.
 * @returns A {@link VerifyResponse}, or `undefined` to fall back to facilitator verification.
 */
async function verifyVoucherLocally(
  scheme: BatchSettlementEvmScheme,
  raw: BatchSettlementVoucherPayload,
  requirements: VerifyContext["requirements"],
  channel: Channel | undefined,
  now: number,
): Promise<VerifyResponse | undefined> {
  if (!channel || !isOnchainStateFresh(channel, scheme.getOnchainStateTtlMs(), now)) {
    return;
  }

  if (raw.channelConfig.payerAuthorizer === "0x0000000000000000000000000000000000000000") {
    return;
  }

  const payer = raw.channelConfig.payer;
  const configErr = validateChannelConfig(
    raw.channelConfig,
    raw.voucher.channelId,
    requirements as Parameters<typeof validateChannelConfig>[2],
  );
  if (configErr) {
    return invalidVerifyResponse(payer, configErr);
  }

  if (
    computeChannelId(raw.channelConfig, requirements.network).toLowerCase() !==
    channel.channelId.toLowerCase()
  ) {
    return invalidVerifyResponse(payer, Errors.ErrChannelIdMismatch);
  }

  const signatureOk = await verifyLocalVoucherSignature(raw, requirements.network);
  if (!signatureOk) {
    return invalidVerifyResponse(payer, Errors.ErrInvalidVoucherSignature);
  }

  const maxClaimableAmount = BigInt(raw.voucher.maxClaimableAmount);
  if (maxClaimableAmount > BigInt(channel.balance)) {
    return invalidVerifyResponse(payer, Errors.ErrCumulativeExceedsBalance);
  }

  if (maxClaimableAmount <= BigInt(channel.totalClaimed)) {
    return invalidVerifyResponse(payer, Errors.ErrCumulativeAmountBelowClaimed);
  }

  return {
    isValid: true,
    payer,
    extra: {
      channelId: raw.voucher.channelId,
      balance: channel.balance,
      totalClaimed: channel.totalClaimed,
      withdrawRequestedAt: channel.withdrawRequestedAt,
      refundNonce: channel.refundNonce.toString(),
    },
  };
}

/**
 * Returns whether cached onchain fields for a channel are still within the freshness window.
 *
 * @param channel - Cached channel row.
 * @param ttlMs - Maximum age of `onchainSyncedAt` in milliseconds.
 * @param now - Current wall-clock time in milliseconds.
 * @returns `true` if onchain sync time is present and still within `ttlMs` of `now`.
 */
function isOnchainStateFresh(channel: Channel, ttlMs: number, now: number): boolean {
  return channel.onchainSyncedAt !== undefined && now - channel.onchainSyncedAt <= ttlMs;
}

/**
 * Verifies the EIP-712 voucher signature against the payer authorizer.
 *
 * @param raw - Decoded batch-settlement voucher payload.
 * @param network - EVM network identifier for chain ID / domain.
 * @returns Whether the typed-data signature is valid.
 */
async function verifyLocalVoucherSignature(
  raw: BatchSettlementVoucherPayload,
  network: string,
): Promise<boolean> {
  try {
    return await verifyTypedData({
      address: getAddress(raw.channelConfig.payerAuthorizer),
      domain: getBatchSettlementEip712Domain(getEvmChainId(network)),
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId: raw.voucher.channelId,
        maxClaimableAmount: BigInt(raw.voucher.maxClaimableAmount),
      },
      signature: raw.voucher.signature,
    });
  } catch {
    return false;
  }
}

/**
 * Builds a failed verify response with the payer address preserved for reporting.
 *
 * @param payer - Payer address from the payload.
 * @param invalidReason - Machine-readable failure reason.
 * @returns Invalid {@link VerifyResponse} with `isValid: false`.
 */
function invalidVerifyResponse(payer: `0x${string}`, invalidReason: string): VerifyResponse {
  return { isValid: false, invalidReason, payer };
}

/**
 * Builds the minimal local channel record needed to reserve missing state.
 *
 * @param raw - Batch-settlement payload containing channel config and voucher.
 * @param chargedCumulativeAmount - Local charged base inferred before facilitator verification.
 * @returns Provisional channel state.
 */
function buildProvisionalChannel(
  raw: BatchSettlementVoucherPayload | BatchSettlementDepositPayload | BatchSettlementRefundPayload,
  chargedCumulativeAmount: string,
): Channel {
  return {
    channelId: raw.voucher.channelId,
    channelConfig: raw.channelConfig,
    chargedCumulativeAmount,
    signedMaxClaimable: raw.voucher.maxClaimableAmount,
    signature: raw.voucher.signature,
    balance: "0",
    totalClaimed: "0",
    withdrawRequestedAt: 0,
    refundNonce: 0,
    lastRequestTimestamp: Date.now(),
  };
}

/**
 * Infers the local charged base when storage has no channel record.
 *
 * @param signedMaxClaimable - Client-signed cumulative voucher cap.
 * @param price - Current request amount.
 * @param isPaidPayload - Whether the payload should add `price` to the local base.
 * @returns Inferred charged base as a decimal string.
 */
function inferMissingLocalChargedAmount(
  signedMaxClaimable: string,
  price: string,
  isPaidPayload: boolean,
): string {
  if (!isPaidPayload) {
    return signedMaxClaimable;
  }

  const signed = BigInt(signedMaxClaimable);
  const amount = BigInt(price);
  if (signed < amount) {
    return "0";
  }
  return (signed - amount).toString();
}
