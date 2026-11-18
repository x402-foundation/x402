import type { PaymentRequirements } from "@x402/core/types";
import type { AuthCaptureDeployment } from "./constants";
import type {
  AuthCaptureCollectPayload,
  AuthCaptureExtra,
  Eip3009Payload,
  PaymentInfoStruct,
  Permit2Payload,
} from "./types";

/**
 * Reconstruct the onchain PaymentInfo struct from the inputs the facilitator
 * has after verifying a wire payload. Wire-only inputs: `payer` and `salt`
 * (both from the payload). `preApprovalExpiry` is computed by the caller from
 * the payload (ERC-3009 `validBefore` or Permit2 `deadline`). The remaining
 * fields come from `requirements` (receiver/token/maxAmount) and
 * `requirements.extra` (capture/refund deadlines, fee policy, captureAuthorizer).
 *
 * @param payer - Address recovered from the wire payload's signature.
 * @param preApprovalExpiry - Pre-approval expiry in Unix seconds (from the wire payload).
 * @param salt - 32-byte salt from the wire payload (PaymentInfo.salt).
 * @param requirements - The payment requirements published by the server.
 * @param extra - The validated `AuthCaptureExtra` subset of `requirements.extra`.
 * @param maxAmount - Client-signed maximum; defaults to `requirements.amount`.
 * @returns A PaymentInfo struct ready to hand to the escrow contract.
 */
export function reconstructPaymentInfo(
  payer: `0x${string}`,
  preApprovalExpiry: number,
  salt: `0x${string}`,
  requirements: PaymentRequirements,
  extra: AuthCaptureExtra,
  maxAmount: string = requirements.amount,
): PaymentInfoStruct {
  return {
    operator: extra.captureAuthorizer,
    payer,
    receiver: requirements.payTo as `0x${string}`,
    token: requirements.asset as `0x${string}`,
    maxAmount,
    preApprovalExpiry,
    authorizationExpiry: extra.captureDeadline,
    refundExpiry: extra.refundDeadline,
    minFeeBps: extra.minFeeBps,
    maxFeeBps: extra.maxFeeBps,
    feeReceiver: extra.feeRecipient,
    salt,
  };
}

/**
 * Convert a JS-side PaymentInfo struct (string `maxAmount` and `salt`) into
 * the bigint-typed form viem expects when encoding the onchain tuple.
 *
 * @param p - PaymentInfo with string-form numeric fields.
 * @returns The same struct with `maxAmount` and `salt` coerced to bigint.
 */
export function paymentInfoToContractTuple(p: PaymentInfoStruct) {
  return { ...p, maxAmount: BigInt(p.maxAmount), salt: BigInt(p.salt) };
}

/**
 * Unpack the per-method inputs the escrow needs at collect settle time.
 *
 * `collectorData` is the client's signature exactly as it arrived, ERC-6492 wrapper and
 * all. Both canonical collectors pass it through `ERC6492SignatureHandler`, which strips
 * the wrapper, runs the preparation call via Multicall3, and hands only the inner
 * signature to the token or Permit2. Unwrapping here would therefore drop the deployment
 * step an undeployed payer wallet depends on.
 *
 * @param wirePayload - The verified collect payload (EIP-3009 or Permit2).
 * @param assetTransferMethod - Which envelope the payload uses.
 * @param deployment - Resolved commerce-payments deployment.
 * @returns `preApprovalExpiry`, signed `amount`, `tokenCollector`, and `collectorData`.
 */
export function unpackForSettle(
  wirePayload: AuthCaptureCollectPayload,
  assetTransferMethod: "eip3009" | "permit2",
  deployment: AuthCaptureDeployment,
): {
  preApprovalExpiry: number;
  amount: bigint;
  tokenCollector: `0x${string}`;
  collectorData: `0x${string}`;
} {
  if (assetTransferMethod === "eip3009") {
    const p = wirePayload as Eip3009Payload;
    return {
      preApprovalExpiry: Number(p.authorization.validBefore),
      amount: BigInt(p.authorization.value),
      tokenCollector: deployment.eip3009Collector,
      collectorData: p.signature,
    };
  }
  const p = wirePayload as Permit2Payload;
  return {
    preApprovalExpiry: Number(p.permit2Authorization.deadline),
    amount: BigInt(p.permit2Authorization.permitted.amount),
    tokenCollector: deployment.permit2Collector,
    collectorData: p.signature,
  };
}
