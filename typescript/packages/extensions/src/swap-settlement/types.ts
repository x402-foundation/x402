/**
 * Type definitions for the Swap Settlement Extension
 *
 * This extension enables token-agnostic payments: a payer can satisfy a
 * `PaymentRequirements` entry denominated in one asset (e.g. USDC) while
 * holding a different asset (e.g. WETH, cbBTC) on the same network. The
 * facilitator atomically swaps the payer's input asset and delivers the exact
 * required asset and amount to `payTo` in a single settlement transaction.
 */

import type { FacilitatorExtension, PaymentRequirements } from "@x402/core/types";

/**
 * Extension key for the swap settlement extension.
 */
export const SWAP_SETTLEMENT_KEY = "swap-settlement";

/**
 * Extension identifier for the swap settlement extension.
 */
export const SWAP_SETTLEMENT: FacilitatorExtension = { key: SWAP_SETTLEMENT_KEY };

/**
 * Authorization methods by which the settler may acquire the payer's input asset.
 */
export type SwapAuthorizationMethod = "eip3009" | "permit2" | "eip2612" | "allowance";

/**
 * Server-side swap settlement info included in PaymentRequired.
 *
 * Because swap quotes are short-lived and the 402 response may be cached,
 * this carries discovery data only; live quotes are obtained from `quoteUrl`.
 */
export interface SwapSettlementServerInfo {
  /** Index signature for compatibility with Record<string, unknown> */
  [key: string]: unknown;
  /** Extension version. `"1"` for this specification. */
  version: "1";
  /** Human-readable description of the extension. */
  description?: string;
  /** Endpoint for requesting swap quotes. */
  quoteUrl: string;
  /** CAIP-2 networks on which swap settlement is available. */
  networks: string[];
  /** Subset of authorization methods the facilitator accepts. */
  authorizationMethods: SwapAuthorizationMethod[];
  /** Optional endpoint listing supported input assets per network. */
  inputAssetsUrl?: string;
}

/**
 * Request body for `POST {quoteUrl}`.
 *
 * `paymentRequirements` MUST be the exact `accepts[]` entry the client
 * intends to satisfy. The client selects `inputAsset`; facilitators MUST NOT
 * choose an input asset on the payer's behalf.
 */
export interface SwapQuoteRequest {
  /** The x402 protocol version. */
  x402Version: number;
  /** The exact `accepts[]` entry the client intends to satisfy. */
  paymentRequirements: PaymentRequirements;
  /** The payer address that will sign the authorization. */
  payer: string;
  /** The input asset the payer holds and authorizes. */
  inputAsset: string;
}

/**
 * Per-method readiness entry in the quote response, scoped to this payer,
 * input asset, and network.
 */
export interface SwapQuoteAuthorizationMethodStatus {
  /** The authorization method. */
  method: SwapAuthorizationMethod;
  /** Whether the method is usable without further on-chain action. */
  ready: boolean;
  /** The spender address the payer must have approved (method-dependent). */
  spender?: string;
}

/**
 * Response body of the quote endpoint: a facilitator commitment, identified
 * by `quoteId`, specifying how much input asset is required to produce the
 * exact required amount, valid until `expiresAt`.
 */
export interface SwapQuoteResponse {
  /** Opaque, single-use quote identifier. */
  quoteId: string;
  /** keccak256 of the JCS-serialized payment requirements (0x-hex). */
  requirementsHash: string;
  /** CAIP-2 network of the quote. */
  network: string;
  /** The input asset the quote was computed for. */
  inputAsset: string;
  /** Maximum input-asset amount the settler may pull (uint256 decimal string). */
  maxAmountIn: string;
  /** The settler contract address for this network. */
  settler: string;
  /** Quote expiry (ISO 8601 timestamp). */
  expiresAt: string;
  /** Transparent fee breakdown, denominated in the input asset. */
  fees: {
    /** Facilitator compensation, including any spread (decimal string). */
    facilitatorFee: string;
    /** Estimated swap-route cost (decimal string). */
    estimatedRouteFee: string;
  };
  /** Per-method readiness for this payer, input asset, and network. */
  authorizationMethods: SwapQuoteAuthorizationMethodStatus[];
}

/**
 * The Permit2 witness struct binding a signature to one specific quote,
 * recipient, output asset, and amount. Never transmitted on the wire in
 * hashed form; always used when signing and verifying.
 */
export interface SwapWitness {
  /** keccak256(utf8(quoteId)) (0x-hex, 32 bytes). */
  quoteIdHash: string;
  /** keccak256(jcs(paymentRequirements)) (0x-hex, 32 bytes). */
  requirementsHash: string;
  /** Recipient of the required asset. */
  payTo: string;
  /** The required asset delivered to `payTo`. */
  outputAsset: string;
  /** The exact required amount (uint256 decimal string). */
  outputAmount: string;
}

/**
 * Wire form of a signed Permit2 `PermitWitnessTransferFrom` authorization.
 */
export interface Permit2Authorization {
  /** The permitted token and maximum amount. */
  permitted: {
    /** The input asset address. */
    token: string;
    /** Maximum amount the settler may pull (uint256 decimal string). */
    amount: string;
  };
  /** The payer (token owner). */
  from: string;
  /** The spender (the settler). */
  spender: string;
  /** Permit2 unordered nonce (uint256 decimal string). */
  nonce: string;
  /** Signature deadline (unix seconds, decimal string). */
  deadline: string;
  /** The witness binding the signature to the quote. */
  witness: SwapWitness;
  /** The signature over the typed data as a hex string. */
  signature: string;
}

/**
 * Wire form of a signed EIP-3009 `ReceiveWithAuthorization` authorization.
 */
export interface Eip3009Authorization {
  /** The payer (token owner). */
  from: string;
  /** The payee (the settler). */
  to: string;
  /** Maximum amount the settler may pull (uint256 decimal string). */
  value: string;
  /** Authorization not valid before this time (unix seconds, decimal string). */
  validAfter: string;
  /** Authorization not valid after this time (unix seconds, decimal string). */
  validBefore: string;
  /** MUST equal keccak256(abi.encode(quoteIdHash, requirementsHash)) (0x-hex, 32 bytes). */
  nonce: string;
  /** The signature over the typed data as a hex string. */
  signature: string;
}

/**
 * Wire form of a signed EIP-2612 `permit` authorization (gasless approval
 * bootstrap; carries no quote binding by itself).
 */
export interface Eip2612Authorization {
  /** The payer (token owner). */
  owner: string;
  /** The spender granted allowance (Permit2 RECOMMENDED, or the settler). */
  spender: string;
  /** The approved amount, `>= maxAmountIn` (uint256 decimal string). */
  value: string;
  /** The current EIP-2612 nonce of the owner (decimal string). */
  nonce: string;
  /** Signature deadline (unix seconds, decimal string). */
  deadline: string;
  /** The signature over the typed data as a hex string. */
  signature: string;
}

/**
 * Wire form of a signed EIP-712 `SwapSettlementIntent` for the pre-existing
 * ERC-20 allowance method.
 */
export interface AllowanceAuthorization {
  /** The payer (token owner). */
  from: string;
  /** Maximum amount the settler may pull (uint256 decimal string). */
  maxAmountIn: string;
  /** Signature deadline (unix seconds, decimal string). */
  deadline: string;
  /** The signature over the typed data as a hex string. */
  signature: string;
}

/**
 * Client-populated swap settlement info placed under
 * `PaymentPayload.extensions["swap-settlement"]`.
 *
 * Exactly one authorization object MUST be present, matching the chosen
 * `method`. Exception: for method `"eip2612"` in the Permit2-bootstrap form,
 * BOTH `eip2612Authorization` AND `permit2Authorization` are present — the
 * permit serves purely as gasless approval bootstrap while the Permit2
 * authorization carries the witness binding.
 */
export interface SwapSettlementPayloadInfo {
  /** Index signature for compatibility with Record<string, unknown> */
  [key: string]: unknown;
  /** Extension version. `"1"` for this specification. */
  version: "1";
  /** The quote being consumed. */
  quoteId: string;
  /** The input asset the payer authorizes. */
  inputAsset: string;
  /** The chosen authorization method. */
  method: SwapAuthorizationMethod;
  /** Permit2 authorization (method "permit2", or "eip2612" bootstrap form). */
  permit2Authorization?: Permit2Authorization;
  /** EIP-3009 authorization (method "eip3009"). */
  eip3009Authorization?: Eip3009Authorization;
  /** EIP-2612 permit (method "eip2612"). */
  eip2612Authorization?: Eip2612Authorization;
  /** Allowance intent authorization (method "allowance"). */
  allowanceAuthorization?: AllowanceAuthorization;
}

/**
 * The full extension object as it appears in PaymentRequired.extensions
 * and PaymentPayload.extensions.
 */
export interface SwapSettlementExtension {
  /** Extension info — server discovery data or client-populated payload info. */
  info: SwapSettlementServerInfo | SwapSettlementPayloadInfo;
  /** JSON Schema describing the expected structure of the client info. */
  schema?: Record<string, unknown>;
}

/**
 * Configuration for declaring the swap settlement extension on a resource
 * server (or its facilitator).
 */
export interface SwapSettlementDeclareConfig {
  /** Endpoint for requesting swap quotes. */
  quoteUrl: string;
  /** CAIP-2 networks on which swap settlement is available. */
  networks: string[];
  /** Accepted authorization methods. Defaults to all four. */
  authorizationMethods?: SwapAuthorizationMethod[];
  /** Optional endpoint listing supported input assets per network. */
  inputAssetsUrl?: string;
  /** Human-readable description of the extension. */
  description?: string;
}
