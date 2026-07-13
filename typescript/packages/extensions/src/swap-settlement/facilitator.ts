/**
 * Facilitator functions for extracting and validating Swap Settlement extension data.
 *
 * These functions help facilitators extract the swap settlement info from
 * payment payloads and shape-validate it before quote lookup, signature
 * verification, and settlement.
 */

import type { PaymentPayload } from "@x402/core/types";
import {
  SWAP_SETTLEMENT_KEY,
  type AllowanceAuthorization,
  type Eip2612Authorization,
  type Eip3009Authorization,
  type Permit2Authorization,
  type SwapSettlementPayloadInfo,
} from "./types";

const ADDRESS_PATTERN = /^0x[a-fA-F0-9]{40}$/;
const BYTES32_PATTERN = /^0x[a-fA-F0-9]{64}$/;
const NUMERIC_PATTERN = /^[0-9]+$/;
const HEX_PATTERN = /^0x[a-fA-F0-9]+$/;

/**
 * Checks that a value is a plain (non-array) object.
 *
 * @param value - The value to check
 * @returns True if the value is a non-null, non-array object
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Extracts the swap settlement info from a payment payload's extensions.
 *
 * Expects the spec wire format `{ info: { ... } }` under
 * `extensions["swap-settlement"]`. Returns the info if the base fields
 * (`version`, `quoteId`, `inputAsset`, `method`) are present.
 *
 * @param paymentPayload - The payment payload to extract from
 * @returns The swap settlement payload info, or null if not present
 */
export function extractSwapSettlementInfo(
  paymentPayload: PaymentPayload,
): SwapSettlementPayloadInfo | null {
  if (!paymentPayload.extensions) {
    return null;
  }

  const extension = paymentPayload.extensions[SWAP_SETTLEMENT_KEY];
  if (!isPlainObject(extension)) {
    return null;
  }

  const info = extension.info;
  if (!isPlainObject(info)) {
    return null;
  }

  if (
    typeof info.version !== "string" ||
    typeof info.quoteId !== "string" ||
    typeof info.inputAsset !== "string" ||
    typeof info.method !== "string"
  ) {
    return null;
  }

  return info as SwapSettlementPayloadInfo;
}

/**
 * Validates the shape of a wire `SwapWitness`.
 *
 * @param witness - The witness object to validate
 * @returns True if the witness fields have valid formats
 */
function isValidWitness(witness: unknown): boolean {
  if (!isPlainObject(witness)) {
    return false;
  }
  return (
    typeof witness.quoteIdHash === "string" &&
    BYTES32_PATTERN.test(witness.quoteIdHash) &&
    typeof witness.requirementsHash === "string" &&
    BYTES32_PATTERN.test(witness.requirementsHash) &&
    typeof witness.payTo === "string" &&
    ADDRESS_PATTERN.test(witness.payTo) &&
    typeof witness.outputAsset === "string" &&
    ADDRESS_PATTERN.test(witness.outputAsset) &&
    typeof witness.outputAmount === "string" &&
    NUMERIC_PATTERN.test(witness.outputAmount)
  );
}

/**
 * Validates the shape of a `Permit2Authorization`.
 *
 * @param auth - The authorization object to validate
 * @returns True if the authorization fields have valid formats
 */
function isValidPermit2Authorization(auth: Permit2Authorization): boolean {
  return (
    isPlainObject(auth) &&
    isPlainObject(auth.permitted) &&
    ADDRESS_PATTERN.test(auth.permitted.token) &&
    NUMERIC_PATTERN.test(auth.permitted.amount) &&
    ADDRESS_PATTERN.test(auth.from) &&
    ADDRESS_PATTERN.test(auth.spender) &&
    NUMERIC_PATTERN.test(auth.nonce) &&
    NUMERIC_PATTERN.test(auth.deadline) &&
    isValidWitness(auth.witness) &&
    HEX_PATTERN.test(auth.signature)
  );
}

/**
 * Validates the shape of an `Eip3009Authorization`.
 *
 * @param auth - The authorization object to validate
 * @returns True if the authorization fields have valid formats
 */
function isValidEip3009Authorization(auth: Eip3009Authorization): boolean {
  return (
    isPlainObject(auth) &&
    ADDRESS_PATTERN.test(auth.from) &&
    ADDRESS_PATTERN.test(auth.to) &&
    NUMERIC_PATTERN.test(auth.value) &&
    NUMERIC_PATTERN.test(auth.validAfter) &&
    NUMERIC_PATTERN.test(auth.validBefore) &&
    BYTES32_PATTERN.test(auth.nonce) &&
    HEX_PATTERN.test(auth.signature)
  );
}

/**
 * Validates the shape of an `Eip2612Authorization`.
 *
 * @param auth - The authorization object to validate
 * @returns True if the authorization fields have valid formats
 */
function isValidEip2612Authorization(auth: Eip2612Authorization): boolean {
  return (
    isPlainObject(auth) &&
    ADDRESS_PATTERN.test(auth.owner) &&
    ADDRESS_PATTERN.test(auth.spender) &&
    NUMERIC_PATTERN.test(auth.value) &&
    NUMERIC_PATTERN.test(auth.nonce) &&
    NUMERIC_PATTERN.test(auth.deadline) &&
    HEX_PATTERN.test(auth.signature)
  );
}

/**
 * Validates the shape of an `AllowanceAuthorization`.
 *
 * @param auth - The authorization object to validate
 * @returns True if the authorization fields have valid formats
 */
function isValidAllowanceAuthorization(auth: AllowanceAuthorization): boolean {
  return (
    isPlainObject(auth) &&
    ADDRESS_PATTERN.test(auth.from) &&
    NUMERIC_PATTERN.test(auth.maxAmountIn) &&
    NUMERIC_PATTERN.test(auth.deadline) &&
    HEX_PATTERN.test(auth.signature)
  );
}

/**
 * Validates that the swap settlement info has valid format.
 *
 * Performs shape validation:
 * - `version` is `"1"`;
 * - `method` is one of the known authorization methods;
 * - `quoteId` is a non-empty string;
 * - `inputAsset` is a valid 0x-address;
 * - exactly one authorization object is present, matching `method` — except
 *   for method `"eip2612"`, where `eip2612Authorization` is required and
 *   `permit2Authorization` MAY additionally be present (Permit2-bootstrap
 *   form); authorization objects for other methods must be absent;
 * - the present authorization object(s) are well-formed.
 *
 * Signature recovery, quote lookup, and on-chain checks are out of scope here
 * and remain the facilitator's responsibility.
 *
 * @param info - The swap settlement payload info to validate
 * @returns True if the info is valid, false otherwise
 */
export function validateSwapSettlementInfo(info: SwapSettlementPayloadInfo): boolean {
  if (info.version !== "1") {
    return false;
  }
  if (typeof info.quoteId !== "string" || info.quoteId.length === 0) {
    return false;
  }
  if (typeof info.inputAsset !== "string" || !ADDRESS_PATTERN.test(info.inputAsset)) {
    return false;
  }

  const hasPermit2 = info.permit2Authorization !== undefined;
  const hasEip3009 = info.eip3009Authorization !== undefined;
  const hasEip2612 = info.eip2612Authorization !== undefined;
  const hasAllowance = info.allowanceAuthorization !== undefined;

  switch (info.method) {
    case "permit2":
      if (info.permit2Authorization === undefined || hasEip3009 || hasEip2612 || hasAllowance) {
        return false;
      }
      return isValidPermit2Authorization(info.permit2Authorization);
    case "eip3009":
      if (info.eip3009Authorization === undefined || hasPermit2 || hasEip2612 || hasAllowance) {
        return false;
      }
      return isValidEip3009Authorization(info.eip3009Authorization);
    case "eip2612":
      // Permit2-bootstrap form: the permit is the gasless approval bootstrap,
      // the (optional here, quote-dependent) permit2Authorization carries the witness.
      if (info.eip2612Authorization === undefined || hasEip3009 || hasAllowance) {
        return false;
      }
      if (!isValidEip2612Authorization(info.eip2612Authorization)) {
        return false;
      }
      return (
        info.permit2Authorization === undefined ||
        isValidPermit2Authorization(info.permit2Authorization)
      );
    case "allowance":
      if (info.allowanceAuthorization === undefined || hasPermit2 || hasEip3009 || hasEip2612) {
        return false;
      }
      return isValidAllowanceAuthorization(info.allowanceAuthorization);
    default:
      return false;
  }
}
