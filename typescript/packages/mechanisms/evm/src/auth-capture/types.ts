/**
 * auth-capture wire-format types.
 *
 * Spec-level field names (captureAuthorizer, captureDeadline, refundDeadline,
 * feeRecipient) live here at the extra/wire layer. The on-chain PaymentInfo
 * struct keeps the canonical Solidity field names (operator, authorizationExpiry,
 * refundExpiry, feeReceiver) so the EIP-712 typehash stays byte-identical with
 * the AuthCaptureEscrow contract.
 *
 * Salt is NOT in extra. It is generated client-side per signing call and rides
 * on the payload alongside the signature.
 */

import type { AssetTransferMethod } from "../types";

// AuthCaptureExtra — fields in PaymentRequirements.extra.
//
// Fee-policy fields (minFeeBps, maxFeeBps, feeRecipient) are all required.
// No implicit defaults: a merchant who wants no minimum fee writes
// `minFeeBps: 0` explicitly. This forces fee policy to be a conscious choice
// on the wire and avoids "did they mean 0 or did they forget?" ambiguity.
export interface AuthCaptureExtra {
  // Required
  // The only address allowed to call authorize/capture/void/refund/charge on
  // AuthCaptureEscrow (each of those is gated by onlySender(paymentInfo.operator))
  // — i.e., it must be msg.sender of the "Authorize" call. In x402's
  // facilitator-submits flow that means either the facilitator's EOA, or any
  // smart contract that ultimately calls escrow (arbiter with dispute logic,
  // multisig, etc.). Independent of assetTransferMethod — applies to both
  // EIP-3009 and Permit2.
  captureAuthorizer: `0x${string}`; // formerly `operator` in commerce-payments
  captureDeadline: number; // absolute Unix seconds; capture must occur before this
  refundDeadline: number; // absolute Unix seconds; refunds allowed until this
  feeRecipient: `0x${string}`; // address that receives the fee portion (renamed from feeReceiver)
  minFeeBps: number; // floor on the captureAuthorizer's fee; 0 = no minimum
  maxFeeBps: number; // cap on the captureAuthorizer's fee
  name: string; // EIP-712 token-domain name (e.g., "USDC")
  version: string; // EIP-712 token-domain version (e.g., "2")
  // Optional
  autoCapture?: boolean; // default: false. true → facilitator calls charge(), false → authorize()
  assetTransferMethod?: AssetTransferMethod; // default: 'eip3009'
}

/**
 * Type guard for AuthCaptureExtra. Checks the structural shape an auth-capture
 * scheme requires inside `PaymentRequirements.extra`: every spec-mandated
 * required field present with the right primitive type.
 *
 * @param value - Candidate object from `requirements.extra`.
 * @returns True if `value` has every required AuthCaptureExtra field.
 */
export function isAuthCaptureExtra(value: unknown): value is AuthCaptureExtra {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.captureAuthorizer === "string" &&
    typeof v.captureDeadline === "number" &&
    typeof v.refundDeadline === "number" &&
    typeof v.feeRecipient === "string" &&
    typeof v.minFeeBps === "number" &&
    typeof v.maxFeeBps === "number" &&
    typeof v.name === "string" &&
    typeof v.version === "string"
  );
}

// EIP-3009 payload — ReceiveWithAuthorization to the canonical EIP-3009 token collector.
export interface Eip3009Payload {
  authorization: {
    from: `0x${string}`;
    to: `0x${string}`; // EIP3009_TOKEN_COLLECTOR_ADDRESS
    value: string;
    validAfter: string;
    validBefore: string; // = preApprovalExpiry
    nonce: `0x${string}`; // = payer-agnostic PaymentInfo hash
  };
  signature: `0x${string}`;
  salt: `0x${string}`; // bytes32, fresh per request, used to reconstruct PaymentInfo
}

/**
 * Type guard for an EIP-3009-shaped auth-capture payload. Checks for an
 * `authorization` object plus the required `signature` and `salt` fields;
 * field-level validation happens later in `verify()`.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` has the EIP-3009 envelope shape.
 */
export function isEip3009Payload(value: unknown): value is Eip3009Payload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    "authorization" in v &&
    typeof v.authorization === "object" &&
    v.authorization !== null &&
    typeof v.signature === "string" &&
    typeof v.salt === "string"
  );
}

// Permit2 payload — PermitTransferFrom to the canonical Permit2 token collector.
export interface Permit2Payload {
  permit2Authorization: {
    from: `0x${string}`;
    permitted: {
      token: `0x${string}`;
      amount: string;
    };
    spender: `0x${string}`; // PERMIT2_TOKEN_COLLECTOR_ADDRESS
    nonce: string; // uint256 string, = uint256(payer-agnostic PaymentInfo hash)
    deadline: string; // = preApprovalExpiry
  };
  signature: `0x${string}`;
  salt: `0x${string}`; // bytes32, fresh per request, used to reconstruct PaymentInfo
}

/**
 * Type guard for a Permit2-shaped auth-capture payload. Checks for the
 * `permit2Authorization` envelope (with `from`, `spender`, `nonce`,
 * `deadline`, `permitted`) plus the required `signature` and `salt` fields.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` has the Permit2 envelope shape.
 */
export function isPermit2Payload(value: unknown): value is Permit2Payload {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (typeof v.signature !== "string" || typeof v.salt !== "string") return false;
  if (typeof v.permit2Authorization !== "object" || v.permit2Authorization === null) return false;
  const a = v.permit2Authorization as Record<string, unknown>;
  return (
    typeof a.from === "string" &&
    typeof a.spender === "string" &&
    typeof a.nonce === "string" &&
    typeof a.deadline === "string" &&
    typeof a.permitted === "object" &&
    a.permitted !== null
  );
}

// Discriminated union of all auth-capture payload shapes.
export type AuthCapturePayload = Eip3009Payload | Permit2Payload;

/**
 * Type guard for any auth-capture payload. Returns true if `value` matches
 * either the EIP-3009 envelope or the Permit2 envelope.
 *
 * @param value - Candidate payment payload from the wire.
 * @returns True if `value` is a valid auth-capture envelope of either shape.
 */
export function isAuthCapturePayload(value: unknown): value is AuthCapturePayload {
  return isEip3009Payload(value) || isPermit2Payload(value);
}

/**
 * On-chain PaymentInfo struct (canonical Solidity names — DO NOT RENAME).
 * Reconstructed by the facilitator from extra + payload.salt + payer + receiver/asset/amount.
 */
export interface PaymentInfoStruct {
  operator: `0x${string}`; // = extra.captureAuthorizer
  payer: `0x${string}`;
  receiver: `0x${string}`; // = requirements.payTo
  token: `0x${string}`; // = requirements.asset
  maxAmount: string; // = requirements.amount
  preApprovalExpiry: number;
  authorizationExpiry: number; // = extra.captureDeadline
  refundExpiry: number; // = extra.refundDeadline
  minFeeBps: number;
  maxFeeBps: number;
  feeReceiver: `0x${string}`; // = extra.feeRecipient
  salt: `0x${string}`; // = payload.salt
}
