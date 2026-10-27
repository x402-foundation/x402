import type { PaymentPayload, PaymentRequirements, VerifyResponse } from "@x402/core/types";
import {
  assertSupportedHederaNetwork,
  isValidHederaAsset,
  isValidHederaEntityId,
} from "../../utils";
import type { HederaAliasPolicy } from "./config";
import {
  ErrInvalidNetwork,
  ErrInvalidPayload,
  ErrInvalidPaymentRequirements,
  ErrInvalidScheme,
} from "./errors";

/**
 * A failed verification, which always names its code and payer.
 */
export type VerifyRejection = VerifyResponse & {
  isValid: false;
  invalidReason: string;
  payer: string;
};

/**
 * The code each requirements check rejects with.
 */
export type RequirementCodes = {
  scheme: string;
  /**
   * `accepted` names another network, or the network is not supported.
   */
  network: string;
  /**
   * `accepted` differs from the requirements.
   */
  mismatch: string;
  asset: string;
  payTo: string;
  amount: string;
};

/**
 * The codes `cryptoTransfer` has always returned.
 */
export const CRYPTO_TRANSFER_REQUIREMENT_CODES: RequirementCodes = {
  scheme: "unsupported_scheme",
  network: "network_mismatch",
  mismatch: "accepted_payment_requirements_mismatch",
  asset: "invalid_asset",
  payTo: "invalid_exact_hedera_payload_pay_to",
  amount: "invalid_amount",
};

/**
 * The standard x402 v2 codes the scheme spec requires for `transferExecutor`.
 */
export const TRANSFER_EXECUTOR_REQUIREMENT_CODES: RequirementCodes = {
  scheme: ErrInvalidScheme,
  network: ErrInvalidNetwork,
  mismatch: ErrInvalidPayload,
  asset: ErrInvalidPaymentRequirements,
  payTo: ErrInvalidPaymentRequirements,
  amount: ErrInvalidPaymentRequirements,
};

/**
 * Validates request requirements and parity with payload.accepted.
 *
 * @param payload - Payment payload
 * @param requirements - Matched requirements
 * @param options - Validation options
 * @param options.aliasPolicy - Alias handling behavior for the payTo format check
 * @param options.checkFeePayerParity - Whether `extra.feePayer` must match between `accepted` and `requirements`
 * @param options.codes - The code each check rejects with
 * @returns The rejection, or null
 */
export function validateExactRequirements(
  payload: PaymentPayload,
  requirements: PaymentRequirements,
  options: {
    aliasPolicy: HederaAliasPolicy;
    checkFeePayerParity: boolean;
    codes: RequirementCodes;
  },
): VerifyRejection | null {
  const { codes } = options;
  if (payload.accepted.scheme !== "exact" || requirements.scheme !== "exact") {
    return { isValid: false, invalidReason: codes.scheme, payer: "" };
  }
  if (payload.accepted.network !== requirements.network) {
    return { isValid: false, invalidReason: codes.network, payer: "" };
  }
  if (
    payload.accepted.asset !== requirements.asset ||
    payload.accepted.amount !== requirements.amount ||
    payload.accepted.payTo !== requirements.payTo ||
    payload.accepted.maxTimeoutSeconds !== requirements.maxTimeoutSeconds ||
    (options.checkFeePayerParity &&
      payload.accepted.extra?.feePayer !== requirements.extra?.feePayer)
  ) {
    return { isValid: false, invalidReason: codes.mismatch, payer: "" };
  }

  try {
    assertSupportedHederaNetwork(requirements.network);
  } catch {
    return { isValid: false, invalidReason: codes.network, payer: "" };
  }
  if (!isValidHederaAsset(requirements.asset)) {
    return { isValid: false, invalidReason: codes.asset, payer: "" };
  }
  if (!isValidPayToFormatForPolicy(requirements.payTo, options.aliasPolicy)) {
    return { isValid: false, invalidReason: codes.payTo, payer: "" };
  }
  if (!/^\d+$/.test(requirements.amount)) {
    return { isValid: false, invalidReason: codes.amount, payer: "" };
  }

  return null;
}

/**
 * Validates payTo format based on alias policy.
 *
 * @param payTo - Destination account/alias value
 * @param aliasPolicy - Alias handling behavior
 * @returns True when payTo has acceptable format
 */
export function isValidPayToFormatForPolicy(
  payTo: string,
  aliasPolicy: HederaAliasPolicy,
): boolean {
  if (typeof payTo !== "string" || payTo.trim().length === 0) {
    return false;
  }
  if (aliasPolicy === "allow") {
    return true;
  }
  return isValidHederaEntityId(payTo);
}
