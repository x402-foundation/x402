import { toHex } from "viem";

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
