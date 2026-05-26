/**
 * Type definitions for the Sign-In-With-X (SIWX) extension
 *
 * Implements CAIP-122 standard for chain-agnostic wallet-based identity assertions.
 * Per x402 v2 spec: typescript/site/CHANGELOG-v2.md lines 237-341
 */

import { z } from "zod";

/**
 * Extension identifier constant
 */
export const SIGN_IN_WITH_X = "sign-in-with-x";

/**
 * Supported signature schemes per CHANGELOG-v2.md line 271.
 *
 * NOTE: This is primarily informational. Actual signature verification
 * is determined by the chainId prefix, not this field:
 * - `eip155:*` chains use EVM verification (handles eip191, eip712, eip1271, eip6492 automatically)
 * - `solana:*` chains use Ed25519 verification (siws)
 *
 * The signatureScheme field serves as a hint for clients to select
 * the appropriate signing UX.
 */
export type SignatureScheme =
  | "eip191" // personal_sign (default for EVM EOAs)
  | "eip1271" // smart contract wallet verification
  | "eip6492" // counterfactual smart wallet verification
  | "siws"; // Sign-In-With-Solana

/** Signature algorithm type per CAIP-122 */
export type SignatureType = "eip191" | "ed25519";

/**
 * Supported chain configuration in supportedChains array.
 * Specifies which chains the server accepts for authentication.
 */
export interface SupportedChain {
  /** CAIP-2 chain identifier (e.g., "eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") */
  chainId: string;
  /** Signature algorithm type per CAIP-122 */
  type: SignatureType;
  /** Optional signature scheme hint (informational) */
  signatureScheme?: SignatureScheme;
}

/**
 * Server-declared extension info included in PaymentRequired.extensions.
 * Contains message metadata shared across all supported chains.
 * Per CHANGELOG-v2.md lines 263-272
 */
export interface SIWxExtensionInfo {
  /** Server's domain */
  domain: string;
  /** Full resource URI */
  uri: string;
  /** Human-readable purpose for signing */
  statement?: string;
  /** CAIP-122 version, always "1" */
  version: string;
  /** Cryptographic nonce (SDK auto-generates) */
  nonce: string;
  /** ISO 8601 timestamp (SDK auto-generates) */
  issuedAt: string;
  /** Optional expiry (default: +5 min) */
  expirationTime?: string;
  /** Optional validity start */
  notBefore?: string;
  /** Optional correlation ID */
  requestId?: string;
  /** Associated resources */
  resources?: string[];
}

/**
 * JSON Schema for SIWX extension validation
 * Per CHANGELOG-v2.md lines 276-292
 */
export interface SIWxExtensionSchema {
  $schema: string;
  type: "object";
  properties: {
    domain: { type: "string" };
    address: { type: "string" };
    statement?: { type: "string" };
    uri: { type: "string"; format: "uri" };
    version: { type: "string" };
    chainId: { type: "string" };
    type: { type: "string" };
    nonce: { type: "string" };
    issuedAt: { type: "string"; format: "date-time" };
    expirationTime?: { type: "string"; format: "date-time" };
    notBefore?: { type: "string"; format: "date-time" };
    requestId?: { type: "string" };
    resources?: { type: "array"; items: { type: "string"; format: "uri" } };
    signature: { type: "string" };
  };
  required: string[];
}

/**
 * Complete SIWX extension structure (info + supportedChains + schema).
 * Follows standard x402 v2 extension pattern with multi-chain support.
 */
export interface SIWxExtension {
  info: SIWxExtensionInfo;
  supportedChains: SupportedChain[];
  schema: SIWxExtensionSchema;
}

/**
 * Zod schema for SIWX payload validation
 * Client proof payload sent in SIGN-IN-WITH-X header
 * Per CHANGELOG-v2.md lines 301-315
 */
export const SIWxPayloadSchema = z.object({
  domain: z.string(),
  address: z.string(),
  statement: z.string().optional(),
  uri: z.string(),
  version: z.string(),
  chainId: z.string(),
  type: z.enum(["eip191", "ed25519"]),
  nonce: z.string(),
  issuedAt: z.string(),
  expirationTime: z.string().optional(),
  notBefore: z.string().optional(),
  requestId: z.string().optional(),
  resources: z.array(z.string()).optional(),
  signatureScheme: z.enum(["eip191", "eip1271", "eip6492", "siws"]).optional(),
  signature: z.string(),
});

/**
 * Client proof payload type (inferred from zod schema)
 */
export type SIWxPayload = z.infer<typeof SIWxPayloadSchema>;

/**
 * Options for declaring SIWX extension on server.
 *
 * Most fields are optional and derived automatically from request context:
 * - `domain`: Parsed from resourceUri or request URL
 * - `resourceUri`: From request URL
 * - `network`: From payment requirements (accepts[].network)
 *
 * Explicit values override automatic derivation.
 */
export interface DeclareSIWxOptions {
  /** Server's domain. If omitted, derived from resourceUri or request URL. */
  domain?: string;
  /** Full resource URI. If omitted, derived from request URL. */
  resourceUri?: string;
  /** Human-readable purpose */
  statement?: string;
  /** CAIP-122 version (default: "1") */
  version?: string;
  /**
   * Network(s) to support. If omitted, derived from payment requirements.
   * - Single chain: "eip155:8453" or "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
   * - Multi-chain: ["eip155:8453", "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"]
   */
  network?: string | string[];
  /**
   * Optional expiration duration in seconds.
   * - Number (e.g., 300): Signature expires after this many seconds
   * - undefined: Infinite expiration (no expirationTime field in wire format)
   */
  expirationSeconds?: number;
}

/**
 * Validation result from validateSIWxMessage
 */
export interface SIWxValidationResult {
  valid: boolean;
  error?: string;
}

/**
 * Options for message validation
 */
export interface SIWxValidationOptions {
  /** Maximum age for issuedAt in milliseconds (default: 5 minutes) */
  maxAge?: number;
  /** Custom nonce validation function */
  checkNonce?: (nonce: string) => boolean | Promise<boolean>;
}

/**
 * Result from signature verification
 */
export interface SIWxVerifyResult {
  valid: boolean;
  /** Recovered/verified address (checksummed) */
  address?: string;
  error?: string;
}

/**
 * EVM message verifier function type.
 * Compatible with viem's publicClient.verifyMessage().
 *
 * When provided to verifySIWxSignature, enables:
 * - EIP-1271 (deployed smart contract wallets)
 * - EIP-6492 (counterfactual/pre-deploy smart wallets)
 *
 * Without a verifier, only EOA signatures (EIP-191) can be verified.
 *
 * @example
 * ```typescript
 * import { createPublicClient, http } from 'viem';
 * import { base } from 'viem/chains';
 *
 * const publicClient = createPublicClient({ chain: base, transport: http() });
 * // publicClient.verifyMessage satisfies EVMMessageVerifier
 * ```
 */
export type EVMMessageVerifier = (args: {
  address: `0x${string}`;
  message: string;
  signature: `0x${string}`;
}) => Promise<boolean>;

/**
 * Options for SIWX signature verification
 */
export interface SIWxVerifyOptions {
  /**
   * EVM message verifier for smart wallet support.
   *
   * Pass `publicClient.verifyMessage` from viem to enable verification of:
   * - Smart contract wallets (EIP-1271)
   * - Counterfactual/undeployed smart wallets (EIP-6492)
   *
   * If not provided, only EOA signatures are verified using standalone
   * ECDSA recovery (no RPC calls required).
   */
  evmVerifier?: EVMMessageVerifier;
}
