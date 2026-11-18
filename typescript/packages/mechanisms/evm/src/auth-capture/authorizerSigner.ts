import { getAddress, keccak256 } from "viem";
import type { FacilitatorEvmSigner } from "../signer";
import { verifyTypedDataSignature } from "../shared/verifySignature";
import {
  captureTypesForDeployment,
  chargeTypesForDeployment,
  OPERATOR_EIP712_DOMAIN,
  REFUND_TYPES,
  VOID_TYPES,
  type AuthCaptureDeployment,
} from "./constants";
import type { AuthorizerSigner } from "./types";

/**
 * EIP-712 domain for operator Charge/Void/Capture/Refund signatures.
 * `verifyingContract` is the capture authorizer so a signature is bound to
 * its operator by the domain as well as by `paymentInfoHash`.
 *
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - extra.captureAuthorizer (PaymentInfo.operator).
 * @returns Domain fields for `signTypedData` / `verifyTypedData`.
 */
export function getOperatorEip712Domain(
  chainId: number,
  captureAuthorizer: `0x${string}`,
): {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: `0x${string}`;
} {
  return {
    name: OPERATOR_EIP712_DOMAIN.name,
    version: OPERATOR_EIP712_DOMAIN.version,
    chainId,
    verifyingContract: getAddress(captureAuthorizer),
  };
}

export type ChargeDigestV1_0 = {
  paymentInfoHash: `0x${string}`;
  amount: bigint | string;
  tokenCollector: `0x${string}`;
  collectorData: `0x${string}`;
  feeBps: number;
  feeReceiver: `0x${string}`;
};

export type ChargeDigestV1_1 = {
  paymentInfoHash: `0x${string}`;
  amount: bigint | string;
  tokenCollector: `0x${string}`;
  collectorData: `0x${string}`;
  feeAmount: bigint | string;
  feeReceiver: `0x${string}`;
};

export type ChargeDigest = ChargeDigestV1_0 | ChargeDigestV1_1;

export type CaptureDigestV1_0 = {
  paymentInfoHash: `0x${string}`;
  amount: bigint | string;
  feeBps: number;
  feeReceiver: `0x${string}`;
  expectedCapturableAmount: bigint | string;
  expectedRefundableAmount: bigint | string;
};

export type CaptureDigestV1_1 = {
  paymentInfoHash: `0x${string}`;
  amount: bigint | string;
  feeAmount: bigint | string;
  feeReceiver: `0x${string}`;
  expectedCapturableAmount: bigint | string;
  expectedRefundableAmount: bigint | string;
};

export type CaptureDigest = CaptureDigestV1_0 | CaptureDigestV1_1;

export type RefundDigest = {
  paymentInfoHash: `0x${string}`;
  amount: bigint | string;
  tokenCollector: `0x${string}`;
  expectedCapturableAmount: bigint | string;
  expectedRefundableAmount: bigint | string;
};

/**
 * Sign a Charge digest.
 *
 * @param signer - Receiver-authorizer signer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param deployment - Resolved commerce-payments deployment.
 * @param digest - Charge parameters.
 * @returns EIP-712 signature.
 */
export async function signCharge(
  signer: AuthorizerSigner,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  deployment: AuthCaptureDeployment,
  digest: ChargeDigest,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: chargeTypesForDeployment(deployment),
    primaryType: "Charge",
    message: chargeMessage(deployment, digest),
  });
}

/**
 * Sign a Void digest.
 *
 * @param signer - Receiver-authorizer signer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param paymentInfoHash - Escrow payment identifier.
 * @returns EIP-712 signature.
 */
export async function signVoid(
  signer: AuthorizerSigner,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  paymentInfoHash: `0x${string}`,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: VOID_TYPES,
    primaryType: "Void",
    message: { paymentInfoHash },
  });
}

/**
 * Sign a Capture digest.
 *
 * @param signer - Receiver-authorizer signer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param deployment - Resolved commerce-payments deployment.
 * @param digest - Capture parameters including expected balances.
 * @returns EIP-712 signature.
 */
export async function signCapture(
  signer: AuthorizerSigner,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  deployment: AuthCaptureDeployment,
  digest: CaptureDigest,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: captureTypesForDeployment(deployment),
    primaryType: "Capture",
    message: captureMessage(deployment, digest),
  });
}

/**
 * Sign a Refund digest.
 *
 * @param signer - Receiver-authorizer signer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param digest - Refund parameters including expected balances.
 * @returns EIP-712 signature.
 */
export async function signRefund(
  signer: AuthorizerSigner,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  digest: RefundDigest,
): Promise<`0x${string}`> {
  return signer.signTypedData({
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: REFUND_TYPES,
    primaryType: "Refund",
    message: refundMessage(digest),
  });
}

/**
 * Verify a Charge signature (ECDSA or ERC-1271).
 *
 * @param facilitatorSigner - Used for `eth_getCode` / `isValidSignature`.
 * @param authorizer - extra.receiverAuthorizer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param deployment - Resolved commerce-payments deployment.
 * @param digest - Charge parameters.
 * @param signature - Authorizer signature from the payload.
 * @returns True if the signature is valid for `authorizer`.
 */
export async function verifyCharge(
  facilitatorSigner: FacilitatorEvmSigner,
  authorizer: `0x${string}`,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  deployment: AuthCaptureDeployment,
  digest: ChargeDigest,
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(facilitatorSigner, {
    address: getAddress(authorizer),
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: chargeTypesForDeployment(deployment),
    primaryType: "Charge",
    message: chargeMessage(deployment, digest),
    signature,
  });
}

/**
 * Verify a Void signature (ECDSA or ERC-1271).
 *
 * @param facilitatorSigner - Used for `eth_getCode` / `isValidSignature`.
 * @param authorizer - extra.receiverAuthorizer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param paymentInfoHash - Escrow payment identifier.
 * @param signature - Authorizer signature from the payload.
 * @returns True if the signature is valid for `authorizer`.
 */
export async function verifyVoid(
  facilitatorSigner: FacilitatorEvmSigner,
  authorizer: `0x${string}`,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  paymentInfoHash: `0x${string}`,
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(facilitatorSigner, {
    address: getAddress(authorizer),
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: VOID_TYPES,
    primaryType: "Void",
    message: { paymentInfoHash },
    signature,
  });
}

/**
 * Verify a Capture signature (ECDSA or ERC-1271).
 *
 * @param facilitatorSigner - Used for `eth_getCode` / `isValidSignature`.
 * @param authorizer - extra.receiverAuthorizer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param deployment - Resolved commerce-payments deployment.
 * @param digest - Capture parameters.
 * @param signature - Authorizer signature from the payload.
 * @returns True if the signature is valid for `authorizer`.
 */
export async function verifyCapture(
  facilitatorSigner: FacilitatorEvmSigner,
  authorizer: `0x${string}`,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  deployment: AuthCaptureDeployment,
  digest: CaptureDigest,
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(facilitatorSigner, {
    address: getAddress(authorizer),
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: captureTypesForDeployment(deployment),
    primaryType: "Capture",
    message: captureMessage(deployment, digest),
    signature,
  });
}

/**
 * Verify a Refund signature (ECDSA or ERC-1271).
 *
 * @param facilitatorSigner - Used for `eth_getCode` / `isValidSignature`.
 * @param authorizer - extra.receiverAuthorizer.
 * @param chainId - EVM chain id.
 * @param captureAuthorizer - Domain verifyingContract.
 * @param digest - Refund parameters.
 * @param signature - Authorizer signature from the payload.
 * @returns True if the signature is valid for `authorizer`.
 */
export async function verifyRefund(
  facilitatorSigner: FacilitatorEvmSigner,
  authorizer: `0x${string}`,
  chainId: number,
  captureAuthorizer: `0x${string}`,
  digest: RefundDigest,
  signature: `0x${string}`,
): Promise<boolean> {
  return verifyTypedDataSignature(facilitatorSigner, {
    address: getAddress(authorizer),
    domain: getOperatorEip712Domain(chainId, captureAuthorizer),
    types: REFUND_TYPES,
    primaryType: "Refund",
    message: refundMessage(digest),
    signature,
  });
}

/**
 * EIP-712 Charge message fields (collectorData is hashed).
 *
 * @param deployment - Resolved commerce-payments deployment.
 * @param digest - Charge parameters.
 * @returns Typed-data message.
 */
function chargeMessage(
  deployment: AuthCaptureDeployment,
  digest: ChargeDigest,
): Record<string, unknown> {
  const base = {
    paymentInfoHash: digest.paymentInfoHash,
    amount: BigInt(digest.amount),
    tokenCollector: getAddress(digest.tokenCollector),
    collectorDataHash: keccak256(digest.collectorData),
    feeReceiver: getAddress(digest.feeReceiver),
  };
  if (deployment.version === "v1.0") {
    return { ...base, feeBps: (digest as ChargeDigestV1_0).feeBps };
  }
  return { ...base, feeAmount: BigInt((digest as ChargeDigestV1_1).feeAmount) };
}

/**
 * EIP-712 Capture message fields.
 *
 * @param deployment - Resolved commerce-payments deployment.
 * @param digest - Capture parameters.
 * @returns Typed-data message.
 */
function captureMessage(
  deployment: AuthCaptureDeployment,
  digest: CaptureDigest,
): Record<string, unknown> {
  const base = {
    paymentInfoHash: digest.paymentInfoHash,
    amount: BigInt(digest.amount),
    feeReceiver: getAddress(digest.feeReceiver),
    expectedCapturableAmount: BigInt(digest.expectedCapturableAmount),
    expectedRefundableAmount: BigInt(digest.expectedRefundableAmount),
  };
  if (deployment.version === "v1.0") {
    return { ...base, feeBps: (digest as CaptureDigestV1_0).feeBps };
  }
  return { ...base, feeAmount: BigInt((digest as CaptureDigestV1_1).feeAmount) };
}

/**
 * EIP-712 Refund message fields.
 *
 * @param digest - Refund parameters.
 * @returns Typed-data message.
 */
function refundMessage(digest: RefundDigest): Record<string, unknown> {
  return {
    paymentInfoHash: digest.paymentInfoHash,
    amount: BigInt(digest.amount),
    tokenCollector: getAddress(digest.tokenCollector),
    expectedCapturableAmount: BigInt(digest.expectedCapturableAmount),
    expectedRefundableAmount: BigInt(digest.expectedRefundableAmount),
  };
}
