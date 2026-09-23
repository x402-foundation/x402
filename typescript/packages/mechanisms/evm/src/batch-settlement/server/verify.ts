import type {
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
  VerifyResultContext,
} from "@x402/core/server";
import type { VerifyResponse } from "@x402/core/types";
import type { SchemePaymentRequiredContext } from "@x402/core/types";
import { getAddress, hashTypedData, isAddressEqual, recoverAddress } from "viem";
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
import { channelIdBindingError, computeChannelId, getBatchSettlementEip712Domain } from "../utils";
import { validateChannelConfig } from "../facilitator/utils";
import * as Errors from "../errors";
import type { BatchSettlementEvmScheme } from "./scheme";
import type { Channel } from "./storage";
import { rethrowLockImplementationError } from "./storage";
import { readExtraNumber, readExtraString } from "./utils";

// Framework cleanup hooks release admission locks for normal failures
// This bounded TTL releases channels when cleanup cannot run or complete
const MIN_PENDING_TTL_MS = 5_000; // 5 seconds
const MAX_PENDING_TTL_MS = 10 * 60 * 1000; // 600 seconds
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Computes the bounded admission-lock TTL.
 *
 * @param maxTimeoutSeconds - Resource timeout from payment requirements.
 * @returns TTL in milliseconds, clamped to 5s–600s.
 */
function pendingTtlMs(maxTimeoutSeconds: number | undefined): number {
  const requestedMs = Math.max(0, maxTimeoutSeconds ?? 0) * 1000;
  return Math.min(MAX_PENDING_TTL_MS, Math.max(MIN_PENDING_TTL_MS, requestedMs));
}

/**
 * Builds a fail-closed response when local verification state cannot be established.
 *
 * @returns An abort directive with a stable, non-sensitive reason.
 */
function verificationStateUnavailable(): {
  abort: true;
  reason: string;
  message: string;
} {
  return {
    abort: true,
    reason: Errors.ErrVerificationStateUnavailable,
    message: "Unable to establish channel verification state",
  };
}

/**
 * Lifecycle hook: runs before the facilitator verifies a payment.
 *
 * Cheap rejects (binding, config, amounts, EOA ECDSA) run with no lock. Then
 * this hook acquires an admission lock, performs one `storage.get`, and re-checks
 * the cumulative base under that reservation. Local voucher verify may skip the
 * facilitator; otherwise the lock is held across facilitator `/verify`.
 *
 * Refund vouchers are zero-charge: the expected `maxClaimableAmount` equals
 * the existing `chargedCumulativeAmount`.
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

  const bindErr = channelIdBindingError(
    raw.channelConfig,
    raw.voucher.channelId,
    requirements.network,
  );
  if (bindErr) {
    return {
      abort: true,
      reason: bindErr,
      message: "Channel id does not match channel config",
    };
  }

  if (
    !isNonNegativeIntegerString(raw.voucher.maxClaimableAmount) ||
    !isNonNegativeIntegerString(requirements.amount) ||
    (isBatchSettlementDepositPayload(raw) && !isNonNegativeIntegerString(raw.deposit.amount))
  ) {
    return verificationStateUnavailable();
  }

  if (scheme.getEnforceMinDeposit() && isBatchSettlementDepositPayload(raw)) {
    const minDeposit = BigInt(await scheme.resolveMinDepositHint(requirements));
    if (BigInt(raw.deposit.amount) < minDeposit) {
      return {
        abort: true,
        reason: Errors.ErrDepositBelowMinDeposit,
        message: "Deposit amount is below the server minimum",
      };
    }
  }

  const configErr = validateChannelConfig(
    raw.channelConfig,
    raw.voucher.channelId,
    requirements as Parameters<typeof validateChannelConfig>[2],
  );
  if (configErr) {
    return {
      abort: true,
      reason: configErr,
      message: "Channel config does not match payment requirements",
    };
  }

  if (isBatchSettlementVoucherPayload(raw) && raw.channelConfig.payerAuthorizer !== ZERO_ADDRESS) {
    const signatureOk = await verifyEoaVoucherSignature(raw, requirements.network);
    if (!signatureOk) {
      return {
        abort: true,
        reason: Errors.ErrInvalidVoucherSignature,
        message: "Voucher signature is invalid",
      };
    }
  }

  const channelId = raw.voucher.channelId;
  const now = Date.now();
  const pendingId = createNonce();
  scheme.mergeRequestContext(paymentPayload, { channelId, pendingId });

  try {
    if (
      !(await scheme
        .getLockStorage()
        .acquire(channelId, pendingId, pendingTtlMs(requirements.maxTimeoutSeconds)))
    ) {
      scheme.takeRequestContext(paymentPayload);
      return {
        abort: true,
        reason: Errors.ErrChannelBusy,
        message: "Channel is already processing a request",
      };
    }
    scheme.mergeRequestContext(paymentPayload, { reservationCommitted: true });
  } catch (err) {
    rethrowLockImplementationError(err);
    // Lock-store I/O: continue without a reservation; settle CAS serializes.
  }

  let channelSnapshot: Channel | undefined;
  try {
    channelSnapshot = await scheme.getStorage().get(channelId);
  } catch {
    await scheme.clearPendingRequest(paymentPayload);
    return verificationStateUnavailable();
  }

  const chargedCumulativeAmount =
    channelSnapshot?.chargedCumulativeAmount ??
    inferMissingLocalChargedAmount(
      raw.voucher.maxClaimableAmount,
      requirements.amount,
      isPaidPayload,
    );
  const expectedMaxClaimable = isZeroChargePayload
    ? BigInt(chargedCumulativeAmount)
    : BigInt(chargedCumulativeAmount) + BigInt(requirements.amount);

  if (BigInt(raw.voucher.maxClaimableAmount) !== expectedMaxClaimable) {
    scheme.rememberChannelSnapshot(
      paymentPayload,
      channelSnapshot ?? buildProvisionalChannel(raw, chargedCumulativeAmount),
    );
    await scheme.releasePendingRequest(paymentPayload);
    return {
      abort: true,
      reason: Errors.ErrCumulativeAmountMismatch,
      message: "Client voucher base does not match server state",
    };
  }

  scheme.mergeRequestContext(paymentPayload, { channelSnapshot });

  if (isBatchSettlementVoucherPayload(raw)) {
    let localResult: VerifyResponse | undefined;
    try {
      localResult = evaluateVoucherAgainstCachedState(
        scheme,
        raw,
        requirements,
        channelSnapshot,
        now,
      );
    } catch {
      await scheme.clearPendingRequest(paymentPayload);
      return verificationStateUnavailable();
    }
    if (localResult) {
      if (!localResult.isValid) {
        await scheme.clearPendingRequest(paymentPayload);
        return { skip: true, result: localResult };
      }
      scheme.mergeRequestContext(paymentPayload, { localVerify: true });
      return { skip: true, result: localResult };
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

  if (
    channelIdBindingError(raw.channelConfig, raw.voucher.channelId, paymentPayload.accepted.network)
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
 * Stashes facilitator extras on the request snapshot. Admission is reserved in
 * `handleBeforeVerify`; this hook does not acquire or read storage.
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
): Promise<
  | void
  | { skipHandler: true; response?: { contentType?: string; body?: unknown } }
  | { abort: true; reason: string; message?: string }
> {
  const { paymentPayload, requirements, result } = ctx;
  if (!result.isValid || !result.payer) {
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

  const requestContext = scheme.readRequestContext(paymentPayload);
  if (!requestContext?.pendingId) {
    return verificationStateUnavailable();
  }
  const localVerify = requestContext.localVerify === true;
  const now = Date.now();

  const ex = result.extra ?? {};
  const prior = requestContext.channelSnapshot;
  const base =
    prior?.chargedCumulativeAmount ??
    inferMissingLocalChargedAmount(signedMaxClaimable, requirements.amount, !isRefundVoucher);

  const channelSnapshot: Channel = {
    channelId,
    channelConfig,
    chargedCumulativeAmount: base,
    signedMaxClaimable,
    signature,
    balance: readExtraString(ex, "balance", "0"),
    totalClaimed: readExtraString(ex, "totalClaimed", "0"),
    withdrawRequestedAt: readExtraNumber(ex, "withdrawRequestedAt", 0),
    refundNonce: readExtraNumber(ex, "refundNonce", 0),
    onchainSyncedAt: localVerify ? prior?.onchainSyncedAt : now,
    lastRequestTimestamp: now,
  };

  scheme.mergeRequestContext(paymentPayload, { channelSnapshot });

  if (isRefundVoucher) {
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
  if (
    ctx.reason !== "handler_threw" &&
    ctx.reason !== "handler_failed" &&
    ctx.reason !== "after_verify_aborted"
  ) {
    return;
  }
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Evaluates a voucher against locally cached channel state when that state is fresh.
 *
 * Signature is already checked in {@link handleBeforeVerify}. This only decides
 * facilitator skip vs cached-state accept/reject (freshness, balance, claimed).
 *
 * @param scheme - Batch settlement scheme (TTL for onchain sync freshness).
 * @param raw - Decoded batch-settlement voucher payload.
 * @param requirements - Payment requirements (network, etc.).
 * @param channel - Cached channel row, if any.
 * @param now - Current wall-clock time in milliseconds.
 * @returns A {@link VerifyResponse}, or `undefined` to fall back to facilitator verification.
 */
function evaluateVoucherAgainstCachedState(
  scheme: BatchSettlementEvmScheme,
  raw: BatchSettlementVoucherPayload,
  requirements: VerifyContext["requirements"],
  channel: Channel | undefined,
  now: number,
): VerifyResponse | undefined {
  if (!channel || !isOnchainStateFresh(channel, scheme.getOnchainStateTtlMs(), now)) {
    return;
  }

  if (raw.channelConfig.payerAuthorizer === ZERO_ADDRESS) {
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
 * Verifies an EOA voucher via `ecrecover`, matching
 * `x402BatchSettlement._processVoucherClaim`. Does not need a channel row.
 *
 * @param raw - Decoded batch-settlement voucher payload.
 * @param network - EVM network identifier for chain ID / domain.
 * @returns Whether the recovered signer is `payerAuthorizer`.
 */
async function verifyEoaVoucherSignature(
  raw: BatchSettlementVoucherPayload,
  network: string,
): Promise<boolean> {
  try {
    const digest = hashTypedData({
      domain: getBatchSettlementEip712Domain(getEvmChainId(network)),
      types: voucherTypes,
      primaryType: "Voucher",
      message: {
        channelId: raw.voucher.channelId,
        maxClaimableAmount: BigInt(raw.voucher.maxClaimableAmount),
      },
    });
    const recovered = await recoverAddress({
      hash: digest,
      signature: raw.voucher.signature,
    });
    return isAddressEqual(recovered, getAddress(raw.channelConfig.payerAuthorizer));
  } catch {
    return false;
  }
}

/**
 * Returns whether `value` is a non-negative integer decimal string.
 *
 * @param value - Candidate amount string.
 * @returns `true` when `value` matches `/^\d+$/`.
 */
function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
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
