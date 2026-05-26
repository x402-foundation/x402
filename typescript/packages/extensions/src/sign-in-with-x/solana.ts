/**
 * Solana Sign-In-With-X (SIWS) support
 *
 * Implements CAIP-122 compliant message format and Ed25519 signature verification
 * for Solana wallets.
 */

import { base58 } from "@scure/base";
import nacl from "tweetnacl";
import type { CompleteSIWxInfo } from "./client";
import type { SIWxSigner } from "./sign";

/**
 * Common Solana network CAIP-2 identifiers.
 * Uses genesis hash as the chain reference per CAIP-30.
 */
export const SOLANA_MAINNET = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
export const SOLANA_DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const SOLANA_TESTNET = "solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z";

/**
 * Extract chain reference from CAIP-2 Solana chainId.
 *
 * @param chainId - CAIP-2 format chain ID (e.g., "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp")
 * @returns Chain reference (genesis hash)
 *
 * @example
 * ```typescript
 * extractSolanaChainReference("solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp") // "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp"
 * ```
 */
export function extractSolanaChainReference(chainId: string): string {
  const [, reference] = chainId.split(":");
  return reference;
}

/**
 * Format SIWS message following CAIP-122 ABNF specification.
 *
 * The message format is identical to SIWE (EIP-4361) but uses "Solana account"
 * instead of "Ethereum account" in the header line.
 *
 * @param info - Server-provided extension info
 * @param address - Client's Solana wallet address (Base58 encoded public key)
 * @returns Message string ready for signing
 *
 * @example
 * ```typescript
 * const message = formatSIWSMessage(serverInfo, "BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW");
 * // Returns:
 * // "api.example.com wants you to sign in with your Solana account:
 * // BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW
 * //
 * // Sign in to access your content
 * //
 * // URI: https://api.example.com/data
 * // Version: 1
 * // Chain ID: mainnet
 * // Nonce: abc123
 * // Issued At: 2024-01-01T00:00:00.000Z"
 * ```
 */
export function formatSIWSMessage(info: CompleteSIWxInfo, address: string): string {
  const lines: string[] = [
    `${info.domain} wants you to sign in with your Solana account:`,
    address,
    "",
  ];

  // Statement (optional, with blank line after)
  if (info.statement) {
    lines.push(info.statement, "");
  }

  // Required fields
  lines.push(
    `URI: ${info.uri}`,
    `Version: ${info.version}`,
    `Chain ID: ${extractSolanaChainReference(info.chainId)}`,
    `Nonce: ${info.nonce}`,
    `Issued At: ${info.issuedAt}`,
  );

  // Optional fields
  if (info.expirationTime) {
    lines.push(`Expiration Time: ${info.expirationTime}`);
  }
  if (info.notBefore) {
    lines.push(`Not Before: ${info.notBefore}`);
  }
  if (info.requestId) {
    lines.push(`Request ID: ${info.requestId}`);
  }

  // Resources (optional)
  if (info.resources && info.resources.length > 0) {
    lines.push("Resources:");
    for (const resource of info.resources) {
      lines.push(`- ${resource}`);
    }
  }

  return lines.join("\n");
}

/**
 * Verify Ed25519 signature for SIWS.
 *
 * @param message - The SIWS message that was signed
 * @param signature - Ed25519 signature bytes
 * @param publicKey - Solana public key bytes (32 bytes)
 * @returns true if signature is valid
 *
 * @example
 * ```typescript
 * const messageBytes = new TextEncoder().encode(message);
 * const valid = verifySolanaSignature(message, signatureBytes, publicKeyBytes);
 * ```
 */
export function verifySolanaSignature(
  message: string,
  signature: Uint8Array,
  publicKey: Uint8Array,
): boolean {
  const messageBytes = new TextEncoder().encode(message);
  return nacl.sign.detached.verify(messageBytes, signature, publicKey);
}

/**
 * Decode Base58 string to bytes.
 *
 * Solana uses Base58 encoding (Bitcoin alphabet) for addresses and signatures.
 *
 * @param encoded - Base58 encoded string
 * @returns Decoded bytes
 * @throws Error if string contains invalid Base58 characters
 *
 * @example
 * ```typescript
 * const publicKeyBytes = decodeBase58("BSmWDgE9ex6dZYbiTsJGcwMEgFp8q4aWh92hdErQPeVW");
 * // Returns Uint8Array of 32 bytes
 * ```
 */
export function decodeBase58(encoded: string): Uint8Array {
  return base58.decode(encoded);
}

/**
 * Encode bytes to Base58 string.
 *
 * @param bytes - Bytes to encode
 * @returns Base58 encoded string
 */
export function encodeBase58(bytes: Uint8Array): string {
  return base58.encode(bytes);
}

/**
 * Detect if a signer is Solana-compatible.
 * Checks for Solana-specific properties that don't exist on EVM signers.
 *
 * @param signer - The signer to check
 * @returns true if the signer is a Solana signer
 */
export function isSolanaSigner(signer: SIWxSigner): boolean {
  // SolanaKitSigner has signMessages method (plural) - only Solana has this
  if ("signMessages" in signer && typeof signer.signMessages === "function") {
    return true;
  }
  // WalletAdapterSigner has publicKey property
  // But viem also has publicKey (as hex string), so we need to distinguish:
  // - Solana wallet adapter: publicKey has toBase58() method OR is a non-hex string
  // - viem: publicKey is a hex string starting with 0x
  if ("publicKey" in signer && signer.publicKey) {
    const pk = signer.publicKey;
    // Check for toBase58 method (Solana PublicKey object)
    if (typeof pk === "object" && pk !== null && "toBase58" in pk) {
      return true;
    }
    // Check for non-hex string (Solana base58 address)
    if (typeof pk === "string" && !pk.startsWith("0x")) {
      return true;
    }
  }
  return false;
}
