/**
 * Signature verification for SIWX extension
 *
 * Routes to chain-specific verification based on chainId namespace:
 * - EVM (eip155:*): EOA by default, smart wallet (EIP-1271/EIP-6492) with verifier
 * - Solana (solana:*): Ed25519 signature verification via tweetnacl
 */

import { extractEVMChainId, formatSIWEMessage, verifyEVMSignature } from "./evm";
import { formatSIWSMessage, verifySolanaSignature, decodeBase58 } from "./solana";
import type {
  SIWxPayload,
  SIWxVerifyResult,
  SIWxVerifyOptions,
  SIWxVerifyCode,
  EVMMessageVerifier,
} from "./types";

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
 * if (result.isValid) {
 *   console.log('Verified wallet:', result.payer);
 * } else {
 *   console.error('Verification failed:', result.invalidMessage);
 * }
 * ```
 */
export async function verifySIWxSignature(
  payload: SIWxPayload,
  options?: SIWxVerifyOptions,
): Promise<SIWxVerifyResult> {
  // Route by chain namespace
  if (payload.chainId.startsWith("eip155:")) {
    return await verifyEVMPayload(payload, options?.evmVerifier);
  }

  if (payload.chainId.startsWith("solana:")) {
    return verifySolanaPayload(payload);
  }

  return verifyFailure(
    "invalid_siwx_unsupported_chain",
    `Unsupported chain namespace: ${payload.chainId}. Supported: eip155:* (EVM), solana:* (Solana)`,
  );
}

/**
 * Build a failed verification result.
 *
 * @param invalidReason - Structured verification failure code
 * @param invalidMessage - Human-readable failure message
 * @returns Verification result with isValid set to false
 */
function verifyFailure(invalidReason: SIWxVerifyCode, invalidMessage: string): SIWxVerifyResult {
  return { isValid: false, invalidReason, invalidMessage };
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
  try {
    extractEVMChainId(payload.chainId);
  } catch (error) {
    return verifyFailure(
      "invalid_siwx_chain_id",
      error instanceof Error ? error.message : "Invalid EVM chainId format",
    );
  }

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
      return verifyFailure("invalid_siwx_signature", "Signature verification failed");
    }

    return {
      isValid: true,
      payer: payload.address,
    };
  } catch (error) {
    return verifyFailure(
      "invalid_siwx_verifier_error",
      error instanceof Error ? error.message : "Signature verification failed",
    );
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

  let signature: Uint8Array;
  let publicKey: Uint8Array;

  try {
    signature = decodeBase58(payload.signature);
    publicKey = decodeBase58(payload.address);
  } catch (error) {
    return verifyFailure(
      "invalid_siwx_malformed_signature",
      `Invalid Base58 encoding: ${error instanceof Error ? error.message : "decode failed"}`,
    );
  }

  if (signature.length !== 64) {
    return verifyFailure(
      "invalid_siwx_malformed_signature",
      `Invalid signature length: expected 64 bytes, got ${signature.length}`,
    );
  }

  if (publicKey.length !== 32) {
    return verifyFailure(
      "invalid_siwx_malformed_signature",
      `Invalid public key length: expected 32 bytes, got ${publicKey.length}`,
    );
  }

  const valid = verifySolanaSignature(message, signature, publicKey);

  if (!valid) {
    return verifyFailure("invalid_siwx_signature", "Solana signature verification failed");
  }

  return {
    isValid: true,
    payer: payload.address,
  };
}
