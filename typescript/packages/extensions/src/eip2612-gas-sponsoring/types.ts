/**
 * Type definitions for the EIP-2612 Gas Sponsoring Extension
 *
 * This extension enables gasless approval of the Permit2 contract for tokens
 * that implement EIP-2612. The client signs an off-chain permit, and the
 * facilitator submits it on-chain via `x402Permit2Proxy.settleWithPermit`.
 */

import type { FacilitatorExtension } from "@x402/core/types";

/**
 * Extension identifier for the EIP-2612 gas sponsoring extension.
 */
export const EIP2612_GAS_SPONSORING: FacilitatorExtension = { key: "eip2612GasSponsoring" };

/**
 * EIP-2612 gas sponsoring info populated by the client.
 *
 * Contains the EIP-2612 permit signature and parameters that the facilitator
 * needs to call `x402Permit2Proxy.settleWithPermit`.
 */
export interface Eip2612GasSponsoringInfo {
  /** Index signature for compatibility with Record<string, unknown> */
  [key: string]: unknown;
  /** The address of the sender (token owner). */
  from: string;
  /** The address of the ERC-20 token contract. */
  asset: string;
  /** The address of the spender (Canonical Permit2). */
  spender: string;
  /** The amount to approve (uint256 as decimal string). Typically MaxUint256. */
  amount: string;
  /** The current EIP-2612 nonce of the sender (decimal string). */
  nonce: string;
  /** The timestamp at which the permit signature expires (decimal string). */
  deadline: string;
  /** The 65-byte concatenated EIP-2612 permit signature (r, s, v) as a hex string. */
  signature: string;
  /** Schema version identifier. */
  version: string;
}

/**
 * Server-side EIP-2612 gas sponsoring info included in PaymentRequired.
 * Contains a description and version; the client populates the rest.
 */
export interface Eip2612GasSponsoringServerInfo {
  /** Index signature for compatibility with Record<string, unknown> */
  [key: string]: unknown;
  /** Human-readable description of the extension. */
  description: string;
  /** Schema version identifier. */
  version: string;
}

/**
 * The full extension object as it appears in PaymentRequired.extensions
 * and PaymentPayload.extensions.
 */
export interface Eip2612GasSponsoringExtension {
  /** Extension info - server-provided or client-enriched. */
  info: Eip2612GasSponsoringServerInfo | Eip2612GasSponsoringInfo;
  /** JSON Schema describing the expected structure of info. */
  schema: Record<string, unknown>;
}
