/**
 * Signature verification for SIWX extension
 *
 * Routes to chain-specific verification based on chainId namespace:
 * - EVM (eip155:*): EOA by default, smart wallet (EIP-1271/EIP-6492) with verifier
 * - Solana (solana:*): Ed25519 signature verification via tweetnacl
 */

import { formatSIWEMessage, verifyEVMSignature } from "./evm";
import { formatSIWSMessage, verifySolanaSignature, decodeBase58 } from "./solana";
import type { SIWxPayload, SIWxVerifyResult, SIWxVerifyOptions, EVMMessageVerifier } from "./types";

/**
 * Verify SIWX signature cryptographically.
 *
 * Routes to the appropriate chain-specific verification based on the
 * chainId namespace prefix:
 * - `eip155:*` → EVM verification (EOA by default, smart wallet with verifier)
 * - `solana:*` → Ed25519 signature verification
 *
 * @param payload - The SIWX payload containing signature
 * @param options - Optional verification options
 * @returns Verification result with recovered address if valid
 *
 * @example
 * ```typescript
 * // EOA-only verification (default)
 * const result = await verifySIWxSignature(payload);
 *
 * // Smart wallet verification
 * import { createPublicClient, http } from 'viem';
 * import { base } from 'viem/chains';
 *
 * const publicClient = createPublicClient({ chain: base, transport: http() });
 * const result = await verifySIWxSignature(payload, {
 *   evmVerifier: publicClient.verifyMessage,
 * });
 *
 * if (result.valid) {
 *   console.log('Verified wallet:', result.address);
 * } else {
 *   console.error('Verification failed:', result.error);
 * }
 * ```
 */
export async function verifySIWxSignature(
  payload: SIWxPayload,
  options?: SIWxVerifyOptions,
): Promise<SIWxVerifyResult> {
  try {
    // Route by chain namespace
    if (payload.chainId.startsWith("eip155:")) {
      return verifyEVMPayload(payload, options?.evmVerifier);
    }

    if (payload.chainId.startsWith("solana:")) {
      return verifySolanaPayload(payload);
    }

    return {
      valid: false,
      error: `Unsupported chain namespace: ${payload.chainId}. Supported: eip155:* (EVM), solana:* (Solana)`,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Verification failed",
    };
  }
}

/**
 * Verify EVM signature with optional smart wallet support.
 *
 * @param payload - The SIWX payload containing signature and message data
 * @param verifier - Optional message verifier for EIP-1271/EIP-6492 support
 * @returns Verification result with recovered address if valid
 */
async function verifyEVMPayload(
  payload: SIWxPayload,
  verifier?: EVMMessageVerifier,
): Promise<SIWxVerifyResult> {
  // Reconstruct SIWE message for verification
  const message = formatSIWEMessage(
    {
      domain: payload.domain,
      uri: payload.uri,
      statement: payload.statement,
      version: payload.version,
      chainId: payload.chainId,
      type: payload.type,
      nonce: payload.nonce,
      issuedAt: payload.issuedAt,
      expirationTime: payload.expirationTime,
      notBefore: payload.notBefore,
      requestId: payload.requestId,
      resources: payload.resources,
    },
    payload.address,
  );

  try {
    const valid = await verifyEVMSignature(message, payload.address, payload.signature, verifier);

    if (!valid) {
      return {
        valid: false,
        error: "Signature verification failed",
      };
    }

    return {
      valid: true,
      address: payload.address,
    };
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : "Signature verification failed",
    };
  }
}

/**
 * Verify Solana Ed25519 signature.
 *
 * Reconstructs the SIWS message and verifies using tweetnacl.
 *
 * @param payload - The SIWX payload containing signature and message data
 * @returns Verification result with recovered address if valid
 */
function verifySolanaPayload(payload: SIWxPayload): SIWxVerifyResult {
  // Reconstruct SIWS message
  const message = formatSIWSMessage(
    {
      domain: payload.domain,
      uri: payload.uri,
      statement: payload.statement,
      version: payload.version,
      chainId: payload.chainId,
      type: payload.type,
      nonce: payload.nonce,
      issuedAt: payload.issuedAt,
      expirationTime: payload.expirationTime,
      notBefore: payload.notBefore,
      requestId: payload.requestId,
      resources: payload.resources,
    },
    payload.address,
  );

  // Decode Base58 signature and public key
  let signature: Uint8Array;
  let publicKey: Uint8Array;

  try {
    signature = decodeBase58(payload.signature);
    publicKey = decodeBase58(payload.address);
  } catch (error) {
    return {
      valid: false,
      error: `Invalid Base58 encoding: ${error instanceof Error ? error.message : "decode failed"}`,
    };
  }

  // Validate signature length (Ed25519 signatures are 64 bytes)
  if (signature.length !== 64) {
    return {
      valid: false,
      error: `Invalid signature length: expected 64 bytes, got ${signature.length}`,
    };
  }

  // Validate public key length (Ed25519 public keys are 32 bytes)
  if (publicKey.length !== 32) {
    return {
      valid: false,
      error: `Invalid public key length: expected 32 bytes, got ${publicKey.length}`,
    };
  }

  // Verify Ed25519 signature
  const valid = verifySolanaSignature(message, signature, publicKey);

  if (!valid) {
    return {
      valid: false,
      error: "Solana signature verification failed",
    };
  }

  return {
    valid: true,
    address: payload.address,
  };
}
