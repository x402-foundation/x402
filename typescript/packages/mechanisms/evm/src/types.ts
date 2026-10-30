import { getAddress } from "viem";

/**
 * Asset transfer methods for the exact EVM scheme.
 * - eip3009: Uses transferWithAuthorization (USDC, etc.) - recommended for compatible tokens
 * - permit2: Uses Permit2 + x402Permit2Proxy - universal fallback for any ERC-20
 */
export type AssetTransferMethod = "eip3009" | "permit2";

/**
 * EIP-3009 payload for tokens with native transferWithAuthorization support.
 */
export type ExactEIP3009Payload = {
  signature?: `0x${string}`;
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: `0x${string}`;
  };
};

/**
 * Permit2 witness data structure.
 * Matches the Witness struct in x402Permit2Proxy contract.
 * Note: Upper time bound is enforced by Permit2's `deadline` field, not a witness field.
 */
export type Permit2Witness = {
  to: `0x${string}`;
  validAfter: string;
};

/**
 * Permit2 authorization parameters.
 * Used to reconstruct the signed message for verification.
 */
export type Permit2Authorization = {
  permitted: {
    token: `0x${string}`;
    amount: string;
  };
  spender: `0x${string}`;
  nonce: string;
  deadline: string;
  witness: Permit2Witness;
};

/**
 * Permit2 payload for tokens using the Permit2 + x402Permit2Proxy flow.
 */
export type ExactPermit2Payload = {
  signature: `0x${string}`;
  permit2Authorization: Permit2Authorization & {
    from: `0x${string}`;
  };
};

export type ExactEvmPayloadV1 = ExactEIP3009Payload;

export type ExactEvmPayloadV2 = ExactEIP3009Payload | ExactPermit2Payload;

/**
 * Type guard to check if a payload is a Permit2 payload.
 * Permit2 payloads have a `permit2Authorization` field.
 *
 * @param payload - The payload to check.
 * @returns True if the payload is a Permit2 payload, false otherwise.
 */
export function isPermit2Payload(payload: ExactEvmPayloadV2): payload is ExactPermit2Payload {
  return hasPermit2Authorization(payload);
}

/**
 * Type guard to check if a payload is an EIP-3009 payload.
 * EIP-3009 payloads have an `authorization` field.
 *
 * @param payload - The payload to check.
 * @returns True if the payload is an EIP-3009 payload, false otherwise.
 */
export function isEIP3009Payload(payload: ExactEvmPayloadV2): payload is ExactEIP3009Payload {
  return "authorization" in payload;
}

const UINT256_MAX = (1n << 256n) - 1n;
const UINT256_DECIMAL = /^[0-9]{1,78}$/;
const BYTES32_HEX = /^(?:0x)?[0-9a-fA-F]{64}$/;

/**
 * True for a non-null, non-array object.
 *
 * @param value - Candidate value
 * @returns Whether `value` is a record
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Require a decimal string in the uint256 range.
 *
 * @param path - Field path named in the message
 * @param value - Candidate value
 * @returns A field message, or undefined when `value` is a uint256 decimal string
 */
function uint256Message(path: string, value: unknown): string | undefined {
  if (typeof value === "string" && UINT256_DECIMAL.test(value) && BigInt(value) <= UINT256_MAX) {
    return undefined;
  }
  return `${path} must be a uint256 decimal string`;
}

/**
 * Require a string address.
 *
 * @param path - Field path named in the message
 * @param value - Candidate address field
 * @returns A field message, or undefined when `value` is an EVM address
 */
function addressMessage(path: string, value: unknown): string | undefined {
  if (typeof value !== "string") {
    return `${path} must be a string`;
  }
  try {
    getAddress(value);
  } catch {
    return `${path} must be an address`;
  }
  return undefined;
}

/**
 * True when the raw payload carries a Permit2 authorization.
 *
 * @param payload - Raw object
 * @returns Whether `permit2Authorization` is present
 */
function hasPermit2Authorization(payload: object): boolean {
  return "permit2Authorization" in payload;
}

/**
 * Require a string signature.
 *
 * @param payload - Raw payload object
 * @returns A field message, or undefined when `signature` is a string
 */
function signatureMessage(payload: Record<string, unknown>): string | undefined {
  if (typeof payload.signature !== "string") {
    return "signature must be a string";
  }
  return undefined;
}

/**
 * Check EIP-3009 authorization field types.
 *
 * @param authorization - Candidate authorization
 * @returns A field message, or undefined when the authorization is well-formed
 */
function eip3009AuthorizationMessage(authorization: unknown): string | undefined {
  if (!isRecord(authorization)) {
    return "authorization must be an object";
  }
  const fromError = addressMessage("authorization.from", authorization.from);
  if (fromError) {
    return fromError;
  }
  const toError = addressMessage("authorization.to", authorization.to);
  if (toError) {
    return toError;
  }
  if (typeof authorization.nonce !== "string" || !BYTES32_HEX.test(authorization.nonce)) {
    return "authorization.nonce must be a 32-byte hex string";
  }
  const valueError = uint256Message("authorization.value", authorization.value);
  if (valueError) {
    return valueError;
  }
  const validAfterError = uint256Message("authorization.validAfter", authorization.validAfter);
  if (validAfterError) {
    return validAfterError;
  }
  const validBeforeError = uint256Message("authorization.validBefore", authorization.validBefore);
  if (validBeforeError) {
    return validBeforeError;
  }
  return undefined;
}

/**
 * Check exact Permit2 authorization field types.
 *
 * @param authorization - Candidate authorization
 * @returns A field message, or undefined when the authorization is well-formed
 */
function permit2AuthorizationMessage(authorization: unknown): string | undefined {
  if (!isRecord(authorization)) {
    return "permit2Authorization must be an object";
  }
  if (!isRecord(authorization.permitted)) {
    return "permit2Authorization.permitted must be an object";
  }
  if (!isRecord(authorization.witness)) {
    return "permit2Authorization.witness must be an object";
  }
  const permitted = authorization.permitted;
  const witness = authorization.witness;
  const fromError = addressMessage("permit2Authorization.from", authorization.from);
  if (fromError) {
    return fromError;
  }
  const spenderError = addressMessage("permit2Authorization.spender", authorization.spender);
  if (spenderError) {
    return spenderError;
  }
  const tokenError = addressMessage("permit2Authorization.permitted.token", permitted.token);
  if (tokenError) {
    return tokenError;
  }
  const witnessToError = addressMessage("permit2Authorization.witness.to", witness.to);
  if (witnessToError) {
    return witnessToError;
  }
  const nonceError = uint256Message("permit2Authorization.nonce", authorization.nonce);
  if (nonceError) {
    return nonceError;
  }
  const deadlineError = uint256Message("permit2Authorization.deadline", authorization.deadline);
  if (deadlineError) {
    return deadlineError;
  }
  const amountError = uint256Message("permit2Authorization.permitted.amount", permitted.amount);
  if (amountError) {
    return amountError;
  }
  return uint256Message("permit2Authorization.witness.validAfter", witness.validAfter);
}

/**
 * Check that a raw EIP-3009 payload has the field types verify and settle parse.
 *
 * @param payload - Raw payload
 * @returns Undefined if well-formed, otherwise a message naming the first malformed field
 */
export function validateEip3009Payload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return "payload must be an object";
  }
  return signatureMessage(payload) ?? eip3009AuthorizationMessage(payload.authorization);
}

/**
 * Check that a raw exact EVM payload has the field types verify and settle parse.
 *
 * @param payload - Raw payload
 * @returns Undefined if well-formed, otherwise a message naming the first malformed field
 */
export function validateExactEvmPayload(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return "payload must be an object";
  }
  if (hasPermit2Authorization(payload)) {
    return signatureMessage(payload) ?? permit2AuthorizationMessage(payload.permit2Authorization);
  }
  return validateEip3009Payload(payload);
}

/**
 * Read `from` without validating the rest of the payload.
 *
 * @param payload - Raw exact EVM payload
 * @returns The authorization `from` value when it is a string
 */
export function getExactEvmPayloadPayer(payload: unknown): string | undefined {
  if (!isRecord(payload)) {
    return undefined;
  }
  const key = hasPermit2Authorization(payload) ? "permit2Authorization" : "authorization";
  const authorization = payload[key];
  if (!isRecord(authorization) || typeof authorization.from !== "string") {
    return undefined;
  }
  return authorization.from;
}

/**
 * Upto Permit2 witness — includes `facilitator` field absent from exact witness.
 * Only the address matching `witness.facilitator` can call settle() on-chain.
 */
export type UptoPermit2Witness = {
  to: `0x${string}`;
  facilitator: `0x${string}`;
  validAfter: string;
};

export type UptoPermit2Authorization = {
  permitted: {
    token: `0x${string}`;
    amount: string;
  };
  spender: `0x${string}`;
  nonce: string;
  deadline: string;
  witness: UptoPermit2Witness;
};

export type UptoPermit2Payload = {
  signature: `0x${string}`;
  permit2Authorization: UptoPermit2Authorization & {
    from: `0x${string}`;
  };
};

// Batch-settlement EVM scheme payload types
export type {
  AuthorizerSigner,
  ChannelConfig,
  ChannelState,
  BatchSettlementDepositPayload,
  BatchSettlementVoucherPayload,
  BatchSettlementRefundPayload,
  BatchSettlementVoucherFields,
  BatchSettlementErc3009Authorization,
  BatchSettlementPermit2Authorization,
  BatchSettlementDepositAuthorization,
  BatchSettlementAssetTransferMethod,
  BatchSettlementClaimPayload,
  BatchSettlementEnrichedRefundPayload,
  BatchSettlementVoucherClaim,
  BatchSettlementPayload,
  BatchSettlementSettlePayload,
  BatchSettlementFacilitatorSettlePayload,
  BatchSettlementPaymentRequirementsExtra,
  BatchSettlementPaymentResponseExtra,
} from "./batch-settlement/types";
export {
  isBatchSettlementDepositPayload,
  isBatchSettlementVoucherPayload,
  isBatchSettlementRefundPayload,
  isBatchSettlementClaimPayload,
  isBatchSettlementSettlePayload,
  isBatchSettlementEnrichedRefundPayload,
} from "./batch-settlement/types";

/**
 * Type guard to check if a payload is an upto Permit2 payload.
 * Validates structural presence of all required fields: signature, permit2Authorization
 * (with from, permitted, spender, nonce, deadline), and a witness containing facilitator.
 *
 * @param payload - The payload to check.
 * @returns True if the payload is an upto Permit2 payload, false otherwise.
 */
export function isUptoPermit2Payload(
  payload: Record<string, unknown>,
): payload is UptoPermit2Payload {
  if (typeof payload.signature !== "string") return false;
  if (!("permit2Authorization" in payload)) return false;

  const auth = payload.permit2Authorization;
  if (typeof auth !== "object" || auth === null) return false;

  const a = auth as Record<string, unknown>;
  if (typeof a.from !== "string") return false;
  if (typeof a.spender !== "string") return false;
  if (typeof a.nonce !== "string") return false;
  if (typeof a.deadline !== "string") return false;

  const permitted = a.permitted;
  if (typeof permitted !== "object" || permitted === null) return false;
  const p = permitted as Record<string, unknown>;
  if (typeof p.token !== "string") return false;
  if (typeof p.amount !== "string") return false;

  const witness = a.witness;
  if (typeof witness !== "object" || witness === null) return false;
  const w = witness as Record<string, unknown>;
  return (
    typeof w.facilitator === "string" &&
    typeof w.to === "string" &&
    typeof w.validAfter === "string"
  );
}
