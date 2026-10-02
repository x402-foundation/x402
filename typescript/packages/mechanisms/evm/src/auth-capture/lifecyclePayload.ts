import type { PaymentRequirements } from "@x402/core/types";
import { feeAmountFromBps, resolveAuthCaptureDeployment } from "./constants";
import { computePaymentInfoHash } from "./nonce";
import { signCapture, signCharge, signRefund, signVoid } from "./authorizerSigner";
import { defaultSubmittedFee, type NormalizedAuthCaptureExtra, type SubmittedFee } from "./extra";
import { reconstructPaymentInfo, unpackForSettle } from "./utils";
import type {
  AuthCaptureCollectPayload,
  AuthCaptureExtra,
  AuthorizerSigner,
  CapturePayload,
  PaymentInfoStruct,
  RefundPayload,
  VoidPayload,
} from "./types";
import { isEip3009Payload } from "./types";

/**
 * Reconstruct PaymentInfo from a collect payload and published requirements.
 *
 * @param collect - Client collect payload.
 * @param requirements - Payment requirements.
 * @param extra - Auth-capture extra.
 * @returns PaymentInfo struct.
 */
export function paymentInfoFromCollect(
  collect: AuthCaptureCollectPayload,
  requirements: PaymentRequirements,
  extra: AuthCaptureExtra,
): PaymentInfoStruct {
  const deployment = resolveAuthCaptureDeployment(extra.authCaptureEscrow)!;
  const unpacked = unpackForSettle(collect, extra.assetTransferMethod ?? "eip3009", deployment);
  const payer = isEip3009Payload(collect)
    ? collect.authorization.from
    : collect.permit2Authorization.from;
  return reconstructPaymentInfo(
    payer,
    unpacked.preApprovalExpiry,
    collect.salt,
    requirements,
    extra,
    unpacked.amount.toString(),
  );
}

export type SignedCaptureFields = {
  amount: string;
  feeReceiver: `0x${string}`;
  expectedCapturableAmount: string;
  expectedRefundableAmount: string;
  authorizerSignature: `0x${string}`;
  voidAuthorizerSignature?: `0x${string}`;
} & ({ feeBps: number; feeAmount?: never } | { feeAmount: string; feeBps?: never });

/**
 * Merge a submitted fee into signed capture fields for the deployment version.
 *
 * @param fee - Submitted fee (`feeBps` or `feeAmount`).
 * @param fields - Capture fields excluding the version-specific fee amount.
 * @returns Signed capture fields with the fee encoding for this deployment.
 */
function signedCaptureFieldsFromFee(
  fee: SubmittedFee,
  fields: Omit<SignedCaptureFields, "feeBps" | "feeAmount" | "feeReceiver"> & {
    feeReceiver: `0x${string}`;
  },
): SignedCaptureFields {
  if (fee.version === "v1.0") {
    return { ...fields, feeBps: fee.feeBps, feeReceiver: fee.feeReceiver };
  }
  return { ...fields, feeAmount: fee.feeAmount, feeReceiver: fee.feeReceiver };
}

/**
 * Sign capture (and optionally void-remainder) authorizer digests shared by
 * sync enrichment and deferred helper settles.
 *
 * @param params - Capture context and optional explicit void-remainder flag.
 * @param params.signer - Authorizer key used to sign capture and void digests.
 * @param params.chainId - EVM chain id for EIP-712 domain separation.
 * @param params.extra - Normalized auth-capture extra (authorizer, fee bounds).
 * @param params.paymentInfoHash - Hash of the escrow PaymentInfo struct.
 * @param params.amount - Atomic capture amount.
 * @param params.capturable - Expected capturable balance before capture.
 * @param params.refundable - Expected refundable balance before capture.
 * @param params.feeBps - Optional submitted fee basis points (v1.0).
 * @param params.feeAmount - Optional submitted absolute fee (v1.1).
 * @param params.feeReceiver - Optional fee recipient address.
 * @param params.voidRemainder - When true, sign a void digest for the remaining hold.
 * @param params.voidOnPartialCapture - When true and amount is below capturable, sign void.
 * @returns Signed capture fields for wire payloads or enrichment.
 */
export async function signCaptureFields(params: {
  signer: AuthorizerSigner;
  chainId: number;
  extra: NormalizedAuthCaptureExtra;
  paymentInfoHash: `0x${string}`;
  amount: string;
  capturable: string;
  refundable: string;
  feeBps?: number;
  feeAmount?: string;
  feeReceiver?: `0x${string}`;
  /** Explicit void-remainder for deferred helper settles. */
  voidRemainder?: boolean;
  /** Sync enrichment: attach void sig when amount is below capturable. */
  voidOnPartialCapture?: boolean;
}): Promise<SignedCaptureFields> {
  const defaultFee = defaultSubmittedFee(params.extra, params.amount);
  const fee: SubmittedFee =
    params.feeBps !== undefined && params.feeReceiver !== undefined
      ? params.extra.deployment.version === "v1.0"
        ? { version: "v1.0", feeBps: params.feeBps, feeReceiver: params.feeReceiver }
        : {
            version: "v1.1",
            feeAmount:
              params.feeAmount ??
              (defaultFee.version === "v1.1"
                ? defaultFee.feeAmount
                : feeAmountFromBps(BigInt(params.amount), params.feeBps).toString()),
            feeReceiver: params.feeReceiver,
          }
      : params.feeAmount !== undefined && params.feeReceiver !== undefined
        ? { version: "v1.1", feeAmount: params.feeAmount, feeReceiver: params.feeReceiver }
        : defaultFee;

  const captureDigest =
    fee.version === "v1.0"
      ? {
          paymentInfoHash: params.paymentInfoHash,
          amount: params.amount,
          feeBps: fee.feeBps,
          feeReceiver: fee.feeReceiver,
          expectedCapturableAmount: params.capturable,
          expectedRefundableAmount: params.refundable,
        }
      : {
          paymentInfoHash: params.paymentInfoHash,
          amount: params.amount,
          feeAmount: fee.feeAmount,
          feeReceiver: fee.feeReceiver,
          expectedCapturableAmount: params.capturable,
          expectedRefundableAmount: params.refundable,
        };

  const authorizerSignature = await signCapture(
    params.signer,
    params.chainId,
    params.extra.captureAuthorizer,
    params.extra.deployment,
    captureDigest,
  );
  const result = signedCaptureFieldsFromFee(fee, {
    amount: params.amount,
    expectedCapturableAmount: params.capturable,
    expectedRefundableAmount: params.refundable,
    authorizerSignature,
    feeReceiver: fee.feeReceiver,
  });
  const needsVoidSig =
    params.voidRemainder === true ||
    (params.voidOnPartialCapture === true && BigInt(params.amount) < BigInt(params.capturable));
  if (needsVoidSig) {
    result.voidAuthorizerSignature = await signVoid(
      params.signer,
      params.chainId,
      params.extra.captureAuthorizer,
      params.paymentInfoHash,
    );
  }
  return result;
}

/**
 * Build additive capture enrichment for sync after-handler settle. Does not
 * re-emit `saltNonce`.
 *
 * @param params - Collect payload, requirements, stored balances, and signer.
 * @param params.collect - Client collect payload from the authorize settle.
 * @param params.requirements - Payment requirements for reconstruction.
 * @param params.extra - Normalized auth-capture extra.
 * @param params.signer - Authorizer signer for capture digests.
 * @param params.chainId - EVM chain id for hashing and signing.
 * @param params.capturable - Current capturable balance on the hold.
 * @param params.refundable - Current refundable balance on the hold.
 * @param params.amount - Capture amount for this settle.
 * @param params.paymentInfo - Server-trusted PaymentInfo; when omitted, reconstructed from collect + requirements.
 * @returns Fields to merge into the client payload.
 */
export async function buildCaptureEnrichment(params: {
  collect: AuthCaptureCollectPayload;
  requirements: PaymentRequirements;
  extra: NormalizedAuthCaptureExtra;
  signer: AuthorizerSigner;
  chainId: number;
  capturable: string;
  refundable: string;
  amount: string;
  paymentInfo?: PaymentInfoStruct;
}): Promise<Record<string, unknown>> {
  const paymentInfo =
    params.paymentInfo ?? paymentInfoFromCollect(params.collect, params.requirements, params.extra);
  const paymentInfoHash = computePaymentInfoHash(
    params.chainId,
    paymentInfo,
    params.extra.deployment.escrow,
  );
  const signed = await signCaptureFields({
    signer: params.signer,
    chainId: params.chainId,
    extra: params.extra,
    paymentInfoHash,
    amount: params.amount,
    capturable: params.capturable,
    refundable: params.refundable,
    voidOnPartialCapture: true,
  });
  return {
    type: "capture",
    paymentInfo,
    ...signed,
  };
}

/**
 * Build a signed capture lifecycle payload for deferred helper settles.
 *
 * @param params - Stored payment record fields and capture options.
 * @param params.record - Stored authorized-payment fields needed for capture.
 * @param params.record.paymentInfo - On-chain PaymentInfo struct from storage.
 * @param params.record.paymentInfoHash - Storage key for the authorized payment.
 * @param params.record.capturableAmount - Capturable balance at settle time.
 * @param params.record.refundableAmount - Refundable balance at settle time.
 * @param params.record.saltNonce - Bound salt nonce for lifecycle settles.
 * @param params.extra - Normalized auth-capture extra.
 * @param params.signer - Authorizer signer for capture digests.
 * @param params.chainId - EVM chain id for hashing and signing.
 * @param params.amount - Atomic capture amount.
 * @param params.feeBps - Optional submitted fee basis points (v1.0).
 * @param params.feeAmount - Optional submitted absolute fee (v1.1).
 * @param params.feeReceiver - Optional fee recipient address.
 * @param params.voidRemainder - When true, void the remaining hold after capture.
 * @returns Capture payload ready for facilitator `/settle`.
 */
export async function buildCapturePayload(params: {
  record: {
    paymentInfo: PaymentInfoStruct;
    paymentInfoHash: `0x${string}`;
    capturableAmount: string;
    refundableAmount: string;
    saltNonce: `0x${string}`;
  };
  extra: NormalizedAuthCaptureExtra;
  signer: AuthorizerSigner;
  chainId: number;
  amount: string;
  feeBps?: number;
  feeAmount?: string;
  feeReceiver?: `0x${string}`;
  voidRemainder?: boolean;
}): Promise<CapturePayload> {
  const signed = await signCaptureFields({
    signer: params.signer,
    chainId: params.chainId,
    extra: params.extra,
    paymentInfoHash: params.record.paymentInfoHash,
    amount: params.amount,
    capturable: params.record.capturableAmount,
    refundable: params.record.refundableAmount,
    feeBps: params.feeBps,
    feeAmount: params.feeAmount,
    feeReceiver: params.feeReceiver,
    voidRemainder: params.voidRemainder,
  });
  return {
    type: "capture",
    paymentInfo: params.record.paymentInfo,
    saltNonce: params.record.saltNonce,
    ...signed,
  };
}

/**
 * Build void enrichment for cancel-phase settle.
 *
 * @param params - Collect-derived payment info and signer.
 * @param params.paymentInfo - PaymentInfo struct reconstructed from collect.
 * @param params.extra - Normalized auth-capture extra.
 * @param params.signer - Authorizer signer for void digests.
 * @param params.chainId - EVM chain id for hashing and signing.
 * @param params.paymentInfoHash - Hash of the PaymentInfo struct.
 * @returns Void fields to merge into the payload.
 */
export async function buildVoidEnrichment(params: {
  paymentInfo: PaymentInfoStruct;
  extra: NormalizedAuthCaptureExtra;
  signer: AuthorizerSigner;
  chainId: number;
  paymentInfoHash: `0x${string}`;
}): Promise<Record<string, unknown>> {
  const authorizerSignature = await signVoid(
    params.signer,
    params.chainId,
    params.extra.captureAuthorizer,
    params.paymentInfoHash,
  );
  return { type: "void", paymentInfo: params.paymentInfo, authorizerSignature };
}

/**
 * Build a signed void lifecycle payload.
 *
 * @param params - Stored payment record and signer.
 * @param params.record - Stored authorized-payment fields needed for void.
 * @param params.record.paymentInfo - On-chain PaymentInfo struct from storage.
 * @param params.record.paymentInfoHash - Storage key for the authorized payment.
 * @param params.record.saltNonce - Bound salt nonce for lifecycle settles.
 * @param params.extra - Normalized auth-capture extra.
 * @param params.signer - Authorizer signer for void digests.
 * @param params.chainId - EVM chain id for hashing and signing.
 * @returns Void payload ready for facilitator `/settle`.
 */
export async function buildVoidPayload(params: {
  record: {
    paymentInfo: PaymentInfoStruct;
    paymentInfoHash: `0x${string}`;
    saltNonce: `0x${string}`;
  };
  extra: NormalizedAuthCaptureExtra;
  signer: AuthorizerSigner;
  chainId: number;
}): Promise<VoidPayload> {
  const authorizerSignature = await signVoid(
    params.signer,
    params.chainId,
    params.extra.captureAuthorizer,
    params.record.paymentInfoHash,
  );
  return {
    type: "void",
    paymentInfo: params.record.paymentInfo,
    saltNonce: params.record.saltNonce,
    authorizerSignature,
  };
}

/**
 * Build a signed refund lifecycle payload.
 *
 * @param params - Stored payment record, refund amount, and signer.
 * @param params.record - Stored authorized-payment fields needed for refund.
 * @param params.record.paymentInfo - On-chain PaymentInfo struct from storage.
 * @param params.record.paymentInfoHash - Storage key for the authorized payment.
 * @param params.record.capturableAmount - Capturable balance at settle time.
 * @param params.record.refundableAmount - Refundable balance at settle time.
 * @param params.record.saltNonce - Bound salt nonce for lifecycle settles.
 * @param params.extra - Normalized auth-capture extra.
 * @param params.signer - Authorizer signer for refund digests.
 * @param params.chainId - EVM chain id for hashing and signing.
 * @param params.amount - Atomic refund amount.
 * @returns Refund payload ready for facilitator `/settle`.
 */
export async function buildRefundPayload(params: {
  record: {
    paymentInfo: PaymentInfoStruct;
    paymentInfoHash: `0x${string}`;
    capturableAmount: string;
    refundableAmount: string;
    saltNonce: `0x${string}`;
  };
  extra: NormalizedAuthCaptureExtra;
  signer: AuthorizerSigner;
  chainId: number;
  amount: string;
}): Promise<RefundPayload> {
  const authorizerSignature = await signRefund(
    params.signer,
    params.chainId,
    params.extra.captureAuthorizer,
    {
      paymentInfoHash: params.record.paymentInfoHash,
      amount: params.amount,
      tokenCollector: params.extra.deployment.operatorRefundCollector,
      expectedCapturableAmount: params.record.capturableAmount,
      expectedRefundableAmount: params.record.refundableAmount,
    },
  );
  return {
    type: "refund",
    paymentInfo: params.record.paymentInfo,
    saltNonce: params.record.saltNonce,
    amount: params.amount,
    expectedCapturableAmount: params.record.capturableAmount,
    expectedRefundableAmount: params.record.refundableAmount,
    authorizerSignature,
  };
}

/**
 * Build additive charge-completion enrichment for bound authorization routes.
 *
 * @param params - Collect payload, requirements, and signer.
 * @param params.collect - Client collect payload from the authorize settle.
 * @param params.requirements - Payment requirements for reconstruction.
 * @param params.extra - Normalized auth-capture extra.
 * @param params.signer - Authorizer signer for charge digests.
 * @param params.chainId - EVM chain id for hashing and signing.
 * @param params.amount - Atomic charge amount.
 * @returns Charge completion fields to merge into the payload.
 */
export async function buildChargeCompletionEnrichment(params: {
  collect: AuthCaptureCollectPayload;
  requirements: PaymentRequirements;
  extra: NormalizedAuthCaptureExtra;
  signer: AuthorizerSigner;
  chainId: number;
  amount: string;
}): Promise<Record<string, unknown>> {
  const paymentInfo = paymentInfoFromCollect(params.collect, params.requirements, params.extra);
  const unpacked = unpackForSettle(
    params.collect,
    params.extra.assetTransferMethod,
    params.extra.deployment,
  );
  const fee = defaultSubmittedFee(params.extra, params.amount);
  const paymentInfoHash = computePaymentInfoHash(
    params.chainId,
    paymentInfo,
    params.extra.deployment.escrow,
  );
  const chargeDigest =
    fee.version === "v1.0"
      ? {
          paymentInfoHash,
          amount: params.amount,
          tokenCollector: unpacked.tokenCollector,
          collectorData: unpacked.collectorData,
          feeBps: fee.feeBps,
          feeReceiver: fee.feeReceiver,
        }
      : {
          paymentInfoHash,
          amount: params.amount,
          tokenCollector: unpacked.tokenCollector,
          collectorData: unpacked.collectorData,
          feeAmount: fee.feeAmount,
          feeReceiver: fee.feeReceiver,
        };
  const authorizerSignature = await signCharge(
    params.signer,
    params.chainId,
    params.extra.captureAuthorizer,
    params.extra.deployment,
    chargeDigest,
  );
  if (fee.version === "v1.0") {
    return {
      amount: params.amount,
      feeBps: fee.feeBps,
      feeReceiver: fee.feeReceiver,
      authorizerSignature,
    };
  }
  return {
    amount: params.amount,
    feeAmount: fee.feeAmount,
    feeReceiver: fee.feeReceiver,
    authorizerSignature,
  };
}
