import type { Network, SettleResponse } from "@x402/core/types";
import { isHash, toHex } from "viem";

/**
 * Extract chain ID from a CAIP-2 network identifier (eip155:CHAIN_ID).
 *
 * @param network - The network identifier in CAIP-2 format (e.g., "eip155:8453")
 * @returns The numeric chain ID
 * @throws Error if the network format is invalid
 */
export function getEvmChainId(network: string): number {
  if (network.startsWith("eip155:")) {
    const idStr = network.split(":")[1];
    const chainId = parseInt(idStr, 10);
    if (isNaN(chainId)) {
      throw new Error(`Invalid CAIP-2 chain ID: ${network}`);
    }
    return chainId;
  }

  throw new Error(`Unsupported network format: ${network} (expected eip155:CHAIN_ID)`);
}

/**
 * Get the crypto object from the global scope.
 *
 * @returns The crypto object
 * @throws Error if crypto API is not available
 */
function getCrypto(): Crypto {
  const cryptoObj = globalThis.crypto as Crypto | undefined;
  if (!cryptoObj) {
    throw new Error("Crypto API not available");
  }
  return cryptoObj;
}

/**
 * Create a random 32-byte nonce for EIP-3009 authorization.
 *
 * @returns A hex-encoded 32-byte nonce
 */
export function createNonce(): `0x${string}` {
  return toHex(getCrypto().getRandomValues(new Uint8Array(32)));
}

/**
 * Creates a random 256-bit nonce for Permit2.
 * Permit2 uses uint256 nonces (not bytes32 like EIP-3009).
 *
 * @returns A string representation of the random nonce
 */
export function createPermit2Nonce(): string {
  const randomBytes = getCrypto().getRandomValues(new Uint8Array(32));
  return BigInt(toHex(randomBytes)).toString();
}

/** Matches the truncation length used by the Go and Python SDKs. */
export const MAX_ERROR_MESSAGE_LENGTH = 500;

/**
 * Bounds raw error text (e.g. from an RPC client) before it is placed in a settle/verify
 * errorMessage. RPC/transport errors can carry node URLs, request bodies, or other verbose
 * data that should not be echoed to callers unbounded.
 *
 * @param message - Raw error text to bound.
 * @returns `message`, truncated to {@link MAX_ERROR_MESSAGE_LENGTH} characters.
 */
export function truncateErrorMessage(message: string): string {
  return message.slice(0, MAX_ERROR_MESSAGE_LENGTH);
}

/**
 * Last hash from a two-request extension-signer broadcast (e.g. approve + settle/deposit).
 * Conforming signers return one hash (atomic bundle) or two (sequential); any other
 * count means a partial execution.
 *
 * @param txHashes - Hashes returned by the signer for the two-request broadcast
 * @returns The final transaction hash, or undefined if the hash count is invalid
 */
export function finalHashFromTwoRequestSend<T extends string>(
  txHashes: readonly T[],
): T | undefined {
  if (txHashes.length !== 1 && txHashes.length !== 2) {
    return undefined;
  }
  return txHashes[txHashes.length - 1];
}

/**
 * Checks that a signer-supplied transaction hash is usable for a receipt wait. The all-zero
 * hash is rejected because it reconciles to nothing, so a signer reporting success with a
 * placeholder fails terminally instead of as settlement_pending.
 *
 * @param hash - Transaction hash returned by the signer
 * @returns True if the hash is a well-formed, non-zero 32-byte hash
 */
export function isValidTxHash(hash: string): boolean {
  return isHash(hash) && !/^0x0+$/.test(hash);
}

/**
 * Terminal failure when a signer reports success without a usable transaction hash.
 *
 * @param tx - Value returned in place of a valid transaction hash
 * @param errorReason - Scheme/action-specific terminal error reason
 * @param network - Network the transaction was broadcast to
 * @param payer - Payer address, when known
 * @returns Failed {@link SettleResponse} with no transaction hash
 */
export function invalidBroadcastHashResponse(
  tx: unknown,
  errorReason: string,
  network: Network,
  payer?: string,
): SettleResponse {
  return {
    success: false,
    errorReason,
    errorMessage: `signer returned an invalid transaction hash: ${typeof tx === "string" ? tx : JSON.stringify(tx)}`,
    transaction: "",
    network,
    payer,
  };
}
