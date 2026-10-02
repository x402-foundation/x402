import type {
  FacilitatorContext,
  Network,
  PaymentPayload,
  PaymentRequirements,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";
import type { PendingSettlementStore } from "@x402/core/facilitator";
import { isAddressEqual } from "viem";
import type { FacilitatorEvmSigner } from "../../signer";
import { AUTH_CAPTURE_SCHEME } from "../constants";
import { computePaymentInfoHash, deriveBoundSalt, isNonZeroAddress } from "../nonce";
import { resolveDataSuffix } from "../../shared/extensions";
import {
  waitAndReturnSettleResponse,
  withPendingSettlementStore,
} from "../../shared/settleReceipt";
import { getEvmChainId } from "../../utils";
import { paymentInfoToContractTuple } from "../utils";
import { verifyCapture, verifyRefund, verifyVoid } from "../authorizerSigner";
import type {
  AuthCaptureFacilitatorConfig,
  AuthCaptureLifecyclePayload,
  CapturePayload,
  PaymentInfoStruct,
  PaymentState,
  RefundPayload,
  VoidPayload,
} from "../types";
import { isCapturePayload, isRefundPayload, isVoidPayload } from "../types";
import * as Errors from "../errors";
import {
  captureEscrowArgs,
  captureFeeFromPayload,
  parseAuthCaptureExtra,
  resolveSettleTarget,
  validateSubmittedFee,
  verifyCommon,
  type NormalizedAuthCaptureExtra,
} from "../extra";
import {
  facilitatorAddresses,
  readPaymentStateForBalances,
  readPaymentStateOnce,
  resolveSubmitter,
  simulateEscrowCall,
  submitEscrowCall,
  writeEscrowCall,
} from "./utils";

/**
 * Verify a lifecycle (capture / void / refund) payload.
 *
 * @param signers - Facilitator signer set.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Payload with a lifecycle `type`.
 * @returns VerifyResponse.
 */
export async function verifyLifecycle(
  signers: readonly FacilitatorEvmSigner[],
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureLifecyclePayload,
): Promise<VerifyResponse> {
  if (wirePayload.type === "capture" && !isCapturePayload(wirePayload)) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat };
  }
  if (wirePayload.type === "void") {
    if (!isVoidPayload(wirePayload)) {
      if (
        typeof wirePayload === "object" &&
        wirePayload !== null &&
        "voidAuthorizerSignature" in wirePayload &&
        (wirePayload as Record<string, unknown>).voidAuthorizerSignature !== undefined
      ) {
        return { isValid: false, invalidReason: Errors.ErrVoidAuthorizerSignature };
      }
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat };
    }
  }
  if (wirePayload.type === "refund") {
    if (!isRefundPayload(wirePayload)) {
      if (
        typeof wirePayload === "object" &&
        wirePayload !== null &&
        "voidAuthorizerSignature" in wirePayload &&
        (wirePayload as Record<string, unknown>).voidAuthorizerSignature !== undefined
      ) {
        return { isValid: false, invalidReason: Errors.ErrVoidAuthorizerSignature };
      }
      return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat };
    }
  }

  const common = verifyCommon(
    payload.accepted.scheme,
    payload.accepted.network,
    requirements,
    AUTH_CAPTURE_SCHEME,
    facilitatorAddresses(signers),
    config,
    true,
  );
  if ("error" in common) {
    return { isValid: false, invalidReason: common.error };
  }
  const extra = common.extra;
  const submitter = resolveSubmitter(signers, extra);
  if (!submitter) {
    return { isValid: false, invalidReason: Errors.ErrOperatorNotAdmitted };
  }

  if (
    (wirePayload.type === "capture" || wirePayload.type === "void") &&
    extra.paymentFlow !== "escrow"
  ) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadType };
  }

  if (
    wirePayload.type === "refund" &&
    extra.operatorType === "delegated" &&
    !config?.refundFunding
  ) {
    return { isValid: false, invalidReason: Errors.ErrRefundFundingUnavailable };
  }

  if (!isNonZeroAddress(extra.receiverAuthorizer)) {
    return { isValid: false, invalidReason: Errors.ErrMissingReceiverAuthorizer };
  }

  const paymentInfo = wirePayload.paymentInfo;
  if (!isAddressEqual(paymentInfo.operator, extra.captureAuthorizer)) {
    return { isValid: false, invalidReason: Errors.ErrOperatorMismatch };
  }

  const expectedSalt = deriveBoundSalt(
    extra.receiverAuthorizer,
    extra.policy,
    wirePayload.saltNonce,
  );
  if (BigInt(paymentInfo.salt) !== BigInt(expectedSalt)) {
    return { isValid: false, invalidReason: Errors.ErrSaltBindingMismatch };
  }

  if (!paymentInfoMatchesRequirements(paymentInfo, payload.accepted, extra)) {
    return { isValid: false, invalidReason: Errors.ErrInvalidAuthCaptureExtra };
  }

  const chainId = getEvmChainId(requirements.network);
  const paymentInfoHash = computePaymentInfoHash(chainId, paymentInfo, extra.deployment.escrow);
  const now = Math.floor(Date.now() / 1000);

  if (!wirePayload.authorizerSignature) {
    const facilitatorControlled = facilitatorAddresses(signers).some(a =>
      isAddressEqual(a, extra.receiverAuthorizer),
    );
    return {
      isValid: false,
      invalidReason: facilitatorControlled
        ? Errors.ErrUnauthenticatedLifecycleRequest
        : Errors.ErrAuthorizerSignature,
    };
  }

  if (wirePayload.type === "capture") {
    return verifyCapturePayload(
      submitter,
      extra,
      chainId,
      paymentInfo,
      paymentInfoHash,
      wirePayload,
      now,
    );
  }
  if (wirePayload.type === "void") {
    return verifyVoidPayload(submitter, extra, chainId, paymentInfo, paymentInfoHash, wirePayload);
  }
  return verifyRefundPayload(
    submitter,
    extra,
    chainId,
    paymentInfo,
    paymentInfoHash,
    wirePayload,
    now,
  );
}

/**
 * Wait for a lifecycle broadcast receipt with pending-settlement bookkeeping.
 *
 * @param store - Pending-settlement store keyed by authorizerSignature.
 * @param pendingKey - Store lookup key.
 * @param submitter - Facilitator submitter.
 * @param tx - Broadcast transaction hash.
 * @param network - CAIP-2 network.
 * @param payer - PaymentInfo.payer.
 * @param amount - Settled atomic amount on success.
 * @returns SettleResponse after receipt confirmation or a retryable pending failure.
 */
async function awaitLifecycleSettlement(
  store: PendingSettlementStore,
  pendingKey: string | undefined,
  submitter: FacilitatorEvmSigner,
  tx: `0x${string}`,
  network: Network,
  payer: string,
  amount: string,
): Promise<SettleResponse> {
  return withPendingSettlementStore(
    store,
    pendingKey,
    () =>
      waitAndReturnSettleResponse(submitter, tx, network, payer, {
        failedStatusReason: Errors.ErrTransactionReverted,
        amount,
      }),
    Errors.ErrTransactionReverted,
  );
}

/**
 * Re-verify and settle a lifecycle payload.
 *
 * @param signers - Facilitator signer set.
 * @param config - Facilitator config.
 * @param payload - Wire payment envelope.
 * @param requirements - Published requirements.
 * @param wirePayload - Payload with a lifecycle `type`.
 * @param store - Pending-settlement store keyed by authorizerSignature.
 * @param context - Optional facilitator context for extension hooks.
 * @returns SettleResponse.
 */
export async function settleLifecycle(
  signers: readonly FacilitatorEvmSigner[],
  config: AuthCaptureFacilitatorConfig | undefined,
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  wirePayload: AuthCaptureLifecyclePayload,
  store: PendingSettlementStore,
  context?: FacilitatorContext,
): Promise<SettleResponse> {
  const pendingKey = wirePayload.authorizerSignature;
  const payer = wirePayload.paymentInfo.payer;

  if (pendingKey) {
    const cachedTx = await store.get(pendingKey);
    if (cachedTx) {
      const parsed = parseAuthCaptureExtra(requirements.extra);
      if ("error" in parsed) {
        return {
          success: false,
          errorReason: Errors.ErrSettlementPending,
          transaction: cachedTx,
          network: requirements.network,
          payer,
        };
      }
      const submitter = resolveSubmitter(signers, parsed.extra);
      if (!submitter) {
        return {
          success: false,
          errorReason: Errors.ErrSettlementPending,
          transaction: cachedTx,
          network: requirements.network,
          payer,
        };
      }
      await store.delete(pendingKey);
      const amount =
        wirePayload.type === "refund" || wirePayload.type === "capture" ? wirePayload.amount : "0";
      const result = await awaitLifecycleSettlement(
        store,
        pendingKey,
        submitter,
        cachedTx as `0x${string}`,
        requirements.network,
        payer,
        amount,
      );
      if (result.success && wirePayload.type === "capture" && wirePayload.voidAuthorizerSignature) {
        const tuple = paymentInfoToContractTuple(wirePayload.paymentInfo);
        const settleTarget = resolveSettleTarget(parsed.extra);
        const dataSuffix = await resolveDataSuffix(context, {
          paymentPayload: payload,
          paymentRequirements: requirements,
        });
        await submitEscrowCall(submitter, settleTarget, "void", [tuple], parsed.extra.deployment, {
          dataSuffix,
        });
      }
      return result;
    }
  }

  const verification = await verifyLifecycle(signers, config, payload, requirements, wirePayload);
  if (!verification.isValid) {
    return {
      success: false,
      errorReason: verification.invalidReason ?? Errors.ErrVerificationFailed,
      transaction: "",
      network: requirements.network,
      payer: verification.payer ?? wirePayload.paymentInfo.payer,
    };
  }

  const parsed = parseAuthCaptureExtra(requirements.extra);
  if ("error" in parsed) {
    return {
      success: false,
      errorReason: parsed.error,
      transaction: "",
      network: requirements.network,
      payer: wirePayload.paymentInfo.payer,
    };
  }
  const extra = parsed.extra;
  const submitter = resolveSubmitter(signers, extra);
  if (!submitter) {
    return {
      success: false,
      errorReason: Errors.ErrOperatorNotAdmitted,
      transaction: "",
      network: requirements.network,
      payer: wirePayload.paymentInfo.payer,
    };
  }
  const tuple = paymentInfoToContractTuple(wirePayload.paymentInfo);
  const settleTarget = resolveSettleTarget(extra);
  const dataSuffix = await resolveDataSuffix(context, {
    paymentPayload: payload,
    paymentRequirements: requirements,
  });

  if (wirePayload.type === "void") {
    const written = await writeEscrowCall(
      submitter,
      settleTarget,
      "void",
      [tuple],
      extra.deployment,
      {
        dataSuffix,
      },
    );
    if ("error" in written) {
      return {
        success: false,
        errorReason: written.error,
        transaction: "",
        network: requirements.network,
        payer,
      };
    }
    return awaitLifecycleSettlement(
      store,
      pendingKey,
      submitter,
      written.txHash,
      requirements.network,
      payer,
      "0",
    );
  }

  if (wirePayload.type === "refund") {
    const amount = BigInt(wirePayload.amount);
    const written = await writeEscrowCall(
      submitter,
      settleTarget,
      "refund",
      [tuple, amount, extra.deployment.operatorRefundCollector, "0x"],
      extra.deployment,
      { dataSuffix },
    );
    if ("error" in written) {
      return {
        success: false,
        errorReason: written.error,
        transaction: "",
        network: requirements.network,
        payer,
      };
    }
    return awaitLifecycleSettlement(
      store,
      pendingKey,
      submitter,
      written.txHash,
      requirements.network,
      payer,
      amount.toString(),
    );
  }

  const capture = wirePayload;
  const amount = BigInt(capture.amount);
  const captureFee = captureFeeFromPayload(extra, capture);
  if (!captureFee) {
    return {
      success: false,
      errorReason: Errors.ErrInvalidPayloadFormat,
      transaction: "",
      network: requirements.network,
      payer,
      amount: amount.toString(),
    };
  }
  const written = await writeEscrowCall(
    submitter,
    settleTarget,
    "capture",
    captureEscrowArgs(tuple, amount, captureFee),
    extra.deployment,
    { dataSuffix },
  );
  if ("error" in written) {
    return {
      success: false,
      errorReason: written.error,
      transaction: "",
      network: requirements.network,
      payer,
      amount: amount.toString(),
    };
  }

  const result = await awaitLifecycleSettlement(
    store,
    pendingKey,
    submitter,
    written.txHash,
    requirements.network,
    payer,
    amount.toString(),
  );
  if (!result.success) {
    return result;
  }

  if (capture.voidAuthorizerSignature) {
    // Releasing the remainder is best effort: the capture already moved funds, so this settle
    // succeeded whatever the void does. A remainder left behind — by a race that emptied the
    // hold, or by an RPC failure — stays voidable until authorizationExpiry, after which the
    // payer can reclaim it.
    await submitEscrowCall(submitter, settleTarget, "void", [tuple], extra.deployment, {
      dataSuffix,
    });
  }

  return result;
}

/**
 * Whether payload.paymentInfo matches the published requirements and extra.
 *
 * @param paymentInfo - Struct from the lifecycle payload.
 * @param requirements - Published requirements.
 * @param extra - Normalized extra.
 * @returns True when every committed field matches.
 */
function paymentInfoMatchesRequirements(
  paymentInfo: PaymentInfoStruct,
  requirements: PaymentRequirements,
  extra: NormalizedAuthCaptureExtra,
): boolean {
  return (
    paymentInfo.receiver.toLowerCase() === requirements.payTo.toLowerCase() &&
    paymentInfo.token.toLowerCase() === requirements.asset.toLowerCase() &&
    paymentInfo.maxAmount === requirements.amount &&
    paymentInfo.authorizationExpiry === extra.captureDeadline &&
    paymentInfo.refundExpiry === extra.refundDeadline &&
    paymentInfo.minFeeBps === extra.minFeeBps &&
    paymentInfo.maxFeeBps === extra.maxFeeBps &&
    isAddressEqual(paymentInfo.feeReceiver, extra.feeRecipient)
  );
}

/**
 * Single-use check: signed expected balances must equal onchain state.
 *
 * @param state - Escrow paymentState.
 * @param expectedCapturable - Signed expectedCapturableAmount.
 * @param expectedRefundable - Signed expectedRefundableAmount.
 * @returns True when both balances match.
 */
function balancesMatch(
  state: PaymentState,
  expectedCapturable: bigint,
  expectedRefundable: bigint,
): boolean {
  return (
    state.capturableAmount === expectedCapturable && state.refundableAmount === expectedRefundable
  );
}

/**
 * Verify a capture payload: authorizer signatures, fees, deadlines, paymentState, simulation.
 *
 * @param signer - Facilitator signer.
 * @param extra - Normalized extra.
 * @param chainId - EVM chain id.
 * @param paymentInfo - Payload PaymentInfo.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param wirePayload - Capture envelope.
 * @param now - Unix seconds.
 * @returns VerifyResponse.
 */
async function verifyCapturePayload(
  signer: FacilitatorEvmSigner,
  extra: NormalizedAuthCaptureExtra,
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  paymentInfoHash: `0x${string}`,
  wirePayload: CapturePayload,
  now: number,
): Promise<VerifyResponse> {
  const payer = paymentInfo.payer;
  const captureFee = captureFeeFromPayload(extra, wirePayload);
  if (!captureFee) {
    return { isValid: false, invalidReason: Errors.ErrInvalidPayloadFormat, payer };
  }

  const captureDigest =
    captureFee.version === "v1.0"
      ? {
          paymentInfoHash,
          amount: wirePayload.amount,
          feeBps: captureFee.feeBps,
          feeReceiver: captureFee.feeReceiver,
          expectedCapturableAmount: wirePayload.expectedCapturableAmount,
          expectedRefundableAmount: wirePayload.expectedRefundableAmount,
        }
      : {
          paymentInfoHash,
          amount: wirePayload.amount,
          feeAmount: captureFee.feeAmount,
          feeReceiver: captureFee.feeReceiver,
          expectedCapturableAmount: wirePayload.expectedCapturableAmount,
          expectedRefundableAmount: wirePayload.expectedRefundableAmount,
        };

  const ok = await verifyCapture(
    signer,
    extra.receiverAuthorizer,
    chainId,
    extra.captureAuthorizer,
    extra.deployment,
    captureDigest,
    wirePayload.authorizerSignature,
  );
  if (!ok) {
    return { isValid: false, invalidReason: Errors.ErrAuthorizerSignature, payer };
  }

  if (wirePayload.voidAuthorizerSignature) {
    const voidOk = await verifyVoid(
      signer,
      extra.receiverAuthorizer,
      chainId,
      extra.captureAuthorizer,
      paymentInfoHash,
      wirePayload.voidAuthorizerSignature,
    );
    if (!voidOk) {
      return { isValid: false, invalidReason: Errors.ErrVoidAuthorizerSignature, payer };
    }
  }

  const feeError = validateSubmittedFee(extra, wirePayload.amount, captureFee);
  if (feeError) {
    return { isValid: false, invalidReason: feeError, payer };
  }

  if (now >= paymentInfo.authorizationExpiry) {
    return { isValid: false, invalidReason: Errors.ErrCaptureDeadlineExpired, payer };
  }

  const expectedCapturable = BigInt(wirePayload.expectedCapturableAmount);
  const expectedRefundable = BigInt(wirePayload.expectedRefundableAmount);
  const { state } = await readPaymentStateForBalances(
    signer,
    paymentInfoHash,
    expectedCapturable,
    expectedRefundable,
    extra.deployment.escrow,
  );
  if (!state) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }
  if (!balancesMatch(state, expectedCapturable, expectedRefundable)) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }

  const amount = BigInt(wirePayload.amount);
  if (amount <= 0n || amount > state.capturableAmount) {
    return { isValid: false, invalidReason: Errors.ErrAmountMismatch, payer };
  }
  if (wirePayload.voidAuthorizerSignature) {
    if (amount >= state.capturableAmount) {
      return { isValid: false, invalidReason: Errors.ErrVoidRemainderFullCapture, payer };
    }
  }

  const tuple = paymentInfoToContractTuple(paymentInfo);
  const captureSim = await simulateEscrowCall(
    signer,
    resolveSettleTarget(extra),
    "capture",
    captureEscrowArgs(tuple, amount, captureFee),
    extra.captureAuthorizer,
    extra.deployment,
  );
  if (captureSim !== "ok") {
    return { isValid: false, invalidReason: captureSim, payer };
  }
  if (wirePayload.voidAuthorizerSignature) {
    const voidSim = await simulateEscrowCall(
      signer,
      resolveSettleTarget(extra),
      "void",
      [tuple],
      extra.captureAuthorizer,
      extra.deployment,
    );
    if (voidSim !== "ok") {
      return { isValid: false, invalidReason: voidSim, payer };
    }
  }

  return { isValid: true, payer };
}

/**
 * Verify a void payload: authorizer signature, remaining hold, simulation.
 *
 * @param signer - Facilitator signer.
 * @param extra - Normalized extra.
 * @param chainId - EVM chain id.
 * @param paymentInfo - Payload PaymentInfo.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param wirePayload - Void envelope.
 * @returns VerifyResponse.
 */
async function verifyVoidPayload(
  signer: FacilitatorEvmSigner,
  extra: NormalizedAuthCaptureExtra,
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  paymentInfoHash: `0x${string}`,
  wirePayload: VoidPayload,
): Promise<VerifyResponse> {
  const payer = paymentInfo.payer;
  const ok = await verifyVoid(
    signer,
    extra.receiverAuthorizer,
    chainId,
    extra.captureAuthorizer,
    paymentInfoHash,
    wirePayload.authorizerSignature,
  );
  if (!ok) {
    return { isValid: false, invalidReason: Errors.ErrAuthorizerSignature, payer };
  }

  const state = await readPaymentStateOnce(signer, paymentInfoHash, extra.deployment.escrow);
  if (!state) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }
  if (state.capturableAmount === 0n) {
    return { isValid: false, invalidReason: Errors.ErrZeroAuthorization, payer };
  }

  const tuple = paymentInfoToContractTuple(paymentInfo);
  const sim = await simulateEscrowCall(
    signer,
    resolveSettleTarget(extra),
    "void",
    [tuple],
    extra.captureAuthorizer,
    extra.deployment,
  );
  if (sim !== "ok") {
    return { isValid: false, invalidReason: sim, payer };
  }
  return { isValid: true, payer };
}

/**
 * Verify a refund payload: authorizer signature, deadline, paymentState, simulation.
 *
 * @param signer - Facilitator signer.
 * @param extra - Normalized extra.
 * @param chainId - EVM chain id.
 * @param paymentInfo - Payload PaymentInfo.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param wirePayload - Refund envelope.
 * @param now - Unix seconds.
 * @returns VerifyResponse.
 */
async function verifyRefundPayload(
  signer: FacilitatorEvmSigner,
  extra: NormalizedAuthCaptureExtra,
  chainId: number,
  paymentInfo: PaymentInfoStruct,
  paymentInfoHash: `0x${string}`,
  wirePayload: RefundPayload,
  now: number,
): Promise<VerifyResponse> {
  const payer = paymentInfo.payer;
  const ok = await verifyRefund(
    signer,
    extra.receiverAuthorizer,
    chainId,
    extra.captureAuthorizer,
    {
      paymentInfoHash,
      amount: wirePayload.amount,
      tokenCollector: extra.deployment.operatorRefundCollector,
      expectedCapturableAmount: wirePayload.expectedCapturableAmount,
      expectedRefundableAmount: wirePayload.expectedRefundableAmount,
    },
    wirePayload.authorizerSignature,
  );
  if (!ok) {
    return { isValid: false, invalidReason: Errors.ErrAuthorizerSignature, payer };
  }

  if (now >= paymentInfo.refundExpiry) {
    return { isValid: false, invalidReason: Errors.ErrRefundDeadlineExpired, payer };
  }

  const expectedCapturable = BigInt(wirePayload.expectedCapturableAmount);
  const expectedRefundable = BigInt(wirePayload.expectedRefundableAmount);
  const { state } = await readPaymentStateForBalances(
    signer,
    paymentInfoHash,
    expectedCapturable,
    expectedRefundable,
    extra.deployment.escrow,
  );
  if (!state) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }
  if (!balancesMatch(state, expectedCapturable, expectedRefundable)) {
    return { isValid: false, invalidReason: Errors.ErrUnexpectedPaymentState, payer };
  }

  const amount = BigInt(wirePayload.amount);
  if (amount <= 0n || amount > state.refundableAmount) {
    return { isValid: false, invalidReason: Errors.ErrRefundExceedsCapture, payer };
  }

  const tuple = paymentInfoToContractTuple(paymentInfo);
  const sim = await simulateEscrowCall(
    signer,
    resolveSettleTarget(extra),
    "refund",
    [tuple, amount, extra.deployment.operatorRefundCollector, "0x"],
    extra.captureAuthorizer,
    extra.deployment,
  );
  if (sim !== "ok") {
    return { isValid: false, invalidReason: sim, payer };
  }
  return { isValid: true, payer };
}
