import type {
  VerifiedPaymentCanceledContext,
  VerifyContext,
  VerifyFailureContext,
  VerifyResultContext,
} from "@x402/core/server";
import type { VerifyResponse } from "@x402/core/types";
import type { SchemePaymentRequiredContext } from "@x402/core/types";
import {
  type BatchSettlementChannelStateExtra,
  type BatchSettlementPayload,
  type BatchSettlementVoucherStateExtra,
  isBatchSettlementDepositPayload,
  isBatchSettlementPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementVoucherPayload,
} from "../types";
import { BATCH_SETTLEMENT_SCHEME } from "../constants";
import { createNonce } from "../../utils";
import {
  channelIdBindingError,
  evaluateVoucherAgainstCachedState,
  validateChannelConfig,
  verifyEoaVoucherSignature,
} from "../utils";
import * as Errors from "../errors";
import { pendingTtlMs, requestContextTtlMs } from "../voucherStore";
import type { BatchSettlementEvmScheme } from "./scheme";
import { rethrowLockImplementationError, type Channel } from "./storage";
import { readExtraNumber, readExtraString, readExtraUintString } from "./utils";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

/**
 * Builds a fail-closed response when local verification state cannot be established.
 *
 * @returns An abort directive with a stable, non-sensitive reason.
 */
export function verificationStateUnavailable(): {
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
 * When no local channel record exists, verification is delegated to the facilitator (which checks onchain state);
 * `handleAfterVerify` then checks the voucher against the onchain `totalClaimed` baseline.
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
  if (!isBatchSettlementPayload(raw)) {
    return;
  }

  const serverFieldAbort = abortIfUnexpectedServerAuthoredSettleFields(raw);
  if (serverFieldAbort) {
    return serverFieldAbort;
  }

  const isRefund = isBatchSettlementRefundPayload(raw);

  const bindAbort = abortIfChannelUnbound(raw, requirements.network);
  if (bindAbort) {
    return bindAbort;
  }

  if (
    !isNonNegativeIntegerString(raw.voucher.maxClaimableAmount) ||
    !isNonNegativeIntegerString(requirements.amount) ||
    (isBatchSettlementDepositPayload(raw) && !isNonNegativeIntegerString(raw.deposit.amount))
  ) {
    return verificationStateUnavailable();
  }

  const minDepositAbort = await abortIfBelowMinDeposit(scheme, raw, requirements);
  if (minDepositAbort) {
    return minDepositAbort;
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
  scheme.mergeRequestContext(
    paymentPayload,
    { channelId, pendingId },
    requestContextTtlMs(requirements.maxTimeoutSeconds),
  );

  // Thrown hook errors are warned and skipped by core, so any exception after the pendingId
  // exists must abort here rather than reach facilitator verification.
  try {
    return await reserveAndVerifyLocally(scheme, ctx, raw, {
      isRefund,
      channelId,
      pendingId,
      now,
    });
  } catch (err) {
    console.warn(
      `[batched] BeforeVerify: admission failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return failVerificationClosed(scheme, paymentPayload);
  }
}

/**
 * Acquires the admission lock, checks the cumulative base against the local channel row,
 * and attempts local voucher verification. Exceptions propagate to `handleBeforeVerify`,
 * which converts them into a fail-closed abort.
 *
 * @param scheme - Owning scheme for storage and request-context access.
 * @param ctx - Verify lifecycle context.
 * @param raw - Decoded batch-settlement payload.
 * @param state - Request-scoped values derived by `handleBeforeVerify`.
 * @param state.isRefund - Whether the payload is a refund voucher.
 * @param state.channelId - Channel id from the voucher.
 * @param state.pendingId - Server-minted admission lock owner.
 * @param state.now - Wall-clock timestamp used for cached-state checks.
 * @returns Nothing to continue verification; `abort` to fail; `skip` with a local result.
 */
async function reserveAndVerifyLocally(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyContext,
  raw: BatchSettlementPayload,
  state: { isRefund: boolean; channelId: string; pendingId: string; now: number },
): Promise<
  void | { abort: true; reason: string; message?: string } | { skip: true; result: VerifyResponse }
> {
  const { paymentPayload, requirements } = ctx;
  const { isRefund, channelId, pendingId, now } = state;

  try {
    const locks = scheme.getLockStorage();
    if (locks) {
      if (
        !(await locks.acquire(channelId, pendingId, pendingTtlMs(requirements.maxTimeoutSeconds)))
      ) {
        scheme.takeRequestContext(paymentPayload);
        return {
          abort: true,
          reason: Errors.ErrChannelBusy,
          message: "Channel is already processing a request",
        };
      }
      scheme.mergeRequestContext(paymentPayload, { reservationCommitted: true });
    }
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

  if (channelSnapshot) {
    if (requirements.network) {
      channelSnapshot = { ...channelSnapshot, network: requirements.network };
    }
    const expectedMaxClaimable = isRefund
      ? BigInt(channelSnapshot.chargedCumulativeAmount)
      : BigInt(channelSnapshot.chargedCumulativeAmount) + BigInt(requirements.amount);

    if (BigInt(raw.voucher.maxClaimableAmount) !== expectedMaxClaimable) {
      scheme.rememberChannelSnapshot(paymentPayload, channelSnapshot);
      await scheme.releasePendingRequest(paymentPayload);
      return {
        abort: true,
        reason: Errors.ErrCumulativeAmountMismatch,
        message: "Client voucher base does not match server state",
      };
    }
  }

  scheme.mergeRequestContext(paymentPayload, { channelSnapshot });

  if (isBatchSettlementVoucherPayload(raw)) {
    let localResult: VerifyResponse | undefined;
    try {
      localResult = evaluateVoucherAgainstCachedState(
        raw,
        requirements as Parameters<typeof evaluateVoucherAgainstCachedState>[1],
        channelSnapshot,
        now,
        scheme.getOnchainStateTtlMs(),
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
 * Fails verification closed after an unexpected exception once the request context exists.
 * Drops the context first so `handleAfterVerify` cannot proceed without admission state even
 * if the abort is ignored, then releases the lock best-effort (the lock TTL bounds a failed release).
 *
 * @param scheme - Owning scheme for request-context and lock access.
 * @param paymentPayload - Request-scoped payment payload object.
 * @returns A fail-closed abort directive.
 */
async function failVerificationClosed(
  scheme: BatchSettlementEvmScheme,
  paymentPayload: VerifyContext["paymentPayload"],
): Promise<ReturnType<typeof verificationStateUnavailable>> {
  const context = scheme.takeRequestContext(paymentPayload);
  const locks = scheme.getLockStorage();
  if (locks && context?.reservationCommitted && context.channelId && context.pendingId) {
    try {
      await locks.release(context.channelId, context.pendingId);
    } catch {
      // The lock TTL bounds a failed release.
    }
  }
  return verificationStateUnavailable();
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
  if (!isBatchSettlementPayload(raw)) {
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

  writeCorrectiveAcceptExtra(
    accept,
    {
      channelId: channel.channelId as `0x${string}`,
      balance: channel.balance,
      totalClaimed: channel.totalClaimed,
      withdrawRequestedAt: channel.withdrawRequestedAt,
      refundNonce: String(channel.refundNonce),
      chargedCumulativeAmount: channel.chargedCumulativeAmount,
    },
    {
      signedMaxClaimable: channel.signedMaxClaimable,
      signature: channel.signature as `0x${string}`,
    },
  );
}

/**
 * Rejects deposits below the configured minimum.
 *
 * @param scheme - Scheme policy and hint resolver.
 * @param raw - Decoded payment payload.
 * @param requirements - Current payment requirements.
 * @returns An abort directive or undefined.
 */
export async function abortIfBelowMinDeposit(
  scheme: BatchSettlementEvmScheme,
  raw: unknown,
  requirements: VerifyContext["requirements"],
): Promise<{ abort: true; reason: string; message: string } | undefined> {
  if (!scheme.getEnforceMinDeposit() || !isBatchSettlementDepositPayload(raw)) {
    return undefined;
  }
  const minDeposit = BigInt(await scheme.resolveMinDepositHint(requirements));
  if (BigInt(raw.deposit.amount) < minDeposit) {
    return {
      abort: true,
      reason: Errors.ErrDepositBelowMinDeposit,
      message: "Deposit amount is below the server minimum",
    };
  }
  return undefined;
}

/**
 * Rejects client-supplied server-authored settle fields.
 *
 * @param raw - Decoded payment payload.
 * @returns An abort directive or undefined.
 */
export function abortIfUnexpectedServerAuthoredSettleFields(
  raw: BatchSettlementPayload,
): { abort: true; reason: string; message: string } | undefined {
  if ("pendingId" in raw && raw.pendingId !== undefined) {
    return {
      abort: true,
      reason: Errors.ErrUnexpectedPendingId,
      message: "pendingId is server-authored and must not be supplied by the client",
    };
  }
  if ("cancel" in raw && raw.cancel !== undefined) {
    return {
      abort: true,
      reason: Errors.ErrUnexpectedCancel,
      message: "cancel is server-authored and must not be supplied by the client",
    };
  }
  return undefined;
}

/**
 * Rejects payloads whose channel id does not match their config.
 *
 * @param raw - Decoded payment payload.
 * @param network - Payment requirement network.
 * @returns An abort directive or undefined.
 */
export function abortIfChannelUnbound(
  raw: BatchSettlementPayload,
  network: string,
): { abort: true; reason: string; message: string } | undefined {
  const bindErr = channelIdBindingError(raw.channelConfig, raw.voucher.channelId, network);
  if (!bindErr) {
    return undefined;
  }
  return {
    abort: true,
    reason: bindErr,
    message: "Channel id does not match channel config",
  };
}

/**
 * Builds the resource-server response for an accepted refund.
 *
 * @param channelId - Refunded channel id.
 * @returns A skip-handler response.
 */
export function skipHandlerForRefund(channelId: string): {
  skipHandler: true;
  response: { contentType: string; body: { message: string; channelId: string } };
} {
  return {
    skipHandler: true,
    response: {
      contentType: "application/json",
      body: { message: "Refund acknowledged", channelId },
    },
  };
}

/**
 * Writes corrective channel and voucher state to a payment requirement.
 *
 * @param accept - Payment requirement to enrich.
 * @param accept.extra - Existing extra fields.
 * @param channelState - Corrective channel state.
 * @param voucherState - Corrective voucher state.
 */
export function writeCorrectiveAcceptExtra(
  accept: { extra?: Record<string, unknown> },
  channelState: BatchSettlementChannelStateExtra,
  voucherState: BatchSettlementVoucherStateExtra,
): void {
  accept.extra = {
    ...accept.extra,
    channelState,
    voucherState,
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
  if (!isBatchSettlementPayload(raw)) {
    return;
  }

  const channelId = raw.voucher.channelId;
  const signedMaxClaimable = raw.voucher.maxClaimableAmount;
  const signature = raw.voucher.signature;
  const channelConfig = raw.channelConfig;
  const isRefundVoucher = isBatchSettlementRefundPayload(raw);

  const requestContext = scheme.readRequestContext(paymentPayload);
  if (!requestContext?.pendingId) {
    return verificationStateUnavailable();
  }
  const localVerify = requestContext.localVerify === true;
  const now = Date.now();

  const ex = result.extra ?? {};
  const balance = readExtraString(ex, "balance", "0");
  const totalClaimed = readExtraUintString(ex, "totalClaimed");
  const withdrawRequestedAt = readExtraNumber(ex, "withdrawRequestedAt", 0);
  const refundNonce = readExtraNumber(ex, "refundNonce", 0);

  // No local row: onchain totalClaimed is the baseline; fail closed if absent.
  if (totalClaimed === undefined) {
    return verificationStateUnavailable();
  }

  const prior = requestContext.channelSnapshot;
  const base = prior?.chargedCumulativeAmount ?? totalClaimed;
  const expectedMaxClaimable = isRefundVoucher
    ? BigInt(base)
    : BigInt(base) + BigInt(requirements.amount);
  if (BigInt(signedMaxClaimable) !== expectedMaxClaimable) {
    scheme.rememberChannelSnapshot(
      paymentPayload,
      prior ?? {
        channelId: raw.voucher.channelId,
        channelConfig: raw.channelConfig,
        network: requirements.network,
        chargedCumulativeAmount: base,
        signedMaxClaimable: raw.voucher.maxClaimableAmount,
        signature: raw.voucher.signature,
        balance,
        totalClaimed,
        withdrawRequestedAt,
        refundNonce,
        lastRequestTimestamp: Date.now(),
      },
    );
    await scheme.releasePendingRequest(paymentPayload);
    return {
      abort: true,
      reason: Errors.ErrCumulativeAmountMismatch,
      message: "Client voucher base does not match server state",
    };
  }

  const channelSnapshot: Channel = {
    channelId,
    channelConfig,
    network: requirements.network || prior?.network,
    chargedCumulativeAmount: base,
    signedMaxClaimable,
    signature,
    balance,
    totalClaimed,
    withdrawRequestedAt,
    refundNonce,
    onchainSyncedAt: localVerify ? prior?.onchainSyncedAt : now,
    lastRequestTimestamp: now,
  };

  scheme.mergeRequestContext(paymentPayload, { channelSnapshot });

  if (isRefundVoucher) {
    return skipHandlerForRefund(channelId);
  }
}

/**
 * Releases a reservation after verification fails.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Failed verification context.
 */
export async function handleVerifyFailure(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifyFailureContext,
): Promise<void> {
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Releases a reservation after verified payment handling is canceled.
 *
 * @param scheme - Owning scheme.
 * @param ctx - Cancellation context.
 */
export async function handleVerifiedPaymentCanceled(
  scheme: BatchSettlementEvmScheme,
  ctx: VerifiedPaymentCanceledContext,
): Promise<void> {
  if (
    ctx.reason !== "handler_threw" &&
    ctx.reason !== "handler_failed" &&
    ctx.reason !== "after_verify_aborted" &&
    ctx.reason !== "settlement_preflight_failed"
  ) {
    return;
  }
  await scheme.clearPendingRequest(ctx.paymentPayload);
}

/**
 * Returns whether a value is a non-negative decimal integer.
 *
 * @param value - Candidate amount.
 * @returns Whether the amount is valid.
 */
function isNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value);
}
