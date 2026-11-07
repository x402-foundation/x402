/**
 * EVM Sign-In-With-Ethereum (SIWE) support
 *
 * Implements EIP-4361 compliant message format and signature verification
 * for EVM chains (Ethereum, Base, Polygon, etc.)
 */

import { verifyMessage } from "viem";
import { SiweMessage } from "@signinwithethereum/siwe";
import type { EVMMessageVerifier, SIWxPayload, SIWxVerifyOptions, SIWxVerifyResult } from "./types";
import type { CompleteSIWxInfo } from "./client-common";
import { assertSIWxChallengeBoundToOrigin, buildSIWxPayload } from "./client-common";
import type { EVMSigner, SIWxSigner } from "./sign";

/**
 * Extract numeric chain ID from CAIP-2 EVM chainId.
 *
 * @param chainId - CAIP-2 format chain ID (e.g., "eip155:8453")
 * @returns Numeric chain ID (e.g., 8453)
 * @throws Error if chainId format is invalid
 *
 * @example
 * ```typescript
 * extractEVMChainId("eip155:1")    // 1 (Ethereum mainnet)
 * extractEVMChainId("eip155:8453") // 8453 (Base)
 * extractEVMChainId("eip155:137")  // 137 (Polygon)
 * ```
 */
export function extractEVMChainId(chainId: string): number {
  const match = /^eip155:(\d+)$/.exec(chainId);
  if (!match) {
    throw new Error(`Invalid EVM chainId format: ${chainId}. Expected eip155:<number>`);
  }
  return parseInt(match[1], 10);
}

/**
 * Format SIWE message following EIP-4361 specification.
 *
 * Uses the siwe library to ensure message format matches verification.
 *
 * @param info - Server-provided extension info
 * @param address - Client's EVM wallet address (0x-prefixed)
 * @returns Message string ready for signing
 *
 * @example
 * ```typescript
 * const message = formatSIWEMessage(serverInfo, "0x1234...abcd");
 * // Returns EIP-4361 formatted message:
 * // "api.example.com wants you to sign in with your Ethereum account:
 * // 0x1234...abcd
 * //
 * // Sign in to access your content
 * //
 * // URI: https://api.example.com/data
 * // Version: 1
 * // Chain ID: 8453
 * // Nonce: abc123
 * // Issued At: 2024-01-01T00:00:00.000Z"
 * ```
 */
export function formatSIWEMessage(info: CompleteSIWxInfo, address: string): string {
  const numericChainId = extractEVMChainId(info.chainId);

  const siweMessage = new SiweMessage({
    domain: info.domain,
    address,
    statement: info.statement,
    uri: info.uri,
    version: info.version,
    chainId: numericChainId,
    nonce: info.nonce,
    issuedAt: info.issuedAt,
    expirationTime: info.expirationTime,
    notBefore: info.notBefore,
    requestId: info.requestId,
    resources: info.resources,
  });

  return siweMessage.prepareMessage();
}

/**
 * Verify EVM signature.
 *
 * Supports:
 * - EOA signatures (standard ECDSA via EIP-191) - always available
 * - EIP-1271 (deployed smart contract wallets) - requires verifier
 * - EIP-6492 (counterfactual/pre-deploy smart wallets) - requires verifier
 *
 * @param message - The SIWE message that was signed
 * @param address - The claimed signer address
 * @param signature - The signature to verify
 * @param verifier - Optional message verifier for smart wallet support.
 *                   Pass publicClient.verifyMessage for EIP-1271/EIP-6492 support.
 *                   Without this, only EOA signatures are verified.
 * @returns true if signature is valid
 *
 * @example
 * ```typescript
 * // EOA-only verification (default, no RPC required)
 * const valid = await verifyEVMSignature(message, address, signature);
 *
 * // Smart wallet verification with viem PublicClient
 * import { createPublicClient, http } from 'viem';
 * import { base } from 'viem/chains';
 *
 * const publicClient = createPublicClient({ chain: base, transport: http() });
 * const valid = await verifyEVMSignature(
 *   message,
 *   address,
 *   signature,
 *   publicClient.verifyMessage
 * );
 * ```
 */
export async function verifyEVMSignature(
  message: string,
  address: string,
  signature: string,
  verifier?: EVMMessageVerifier,
): Promise<boolean> {
  const args = {
    address: address as `0x${string}`,
    message,
    signature: signature as `0x${string}`,
  };

  if (verifier) {
    // Use provided verifier (supports EIP-1271/EIP-6492 via RPC)
    return verifier(args);
  }

  // Fallback to standalone verifyMessage (EOA only, no RPC).
  try {
    return await verifyMessage(args);
  } catch {
    return false;
  }
}

/**
 * Detect if a signer is EVM-compatible.
 * Checks for EVM-specific properties.
 *
 * @param signer - The signer to check
 * @returns true if the signer is an EVM signer
 */
export function isEVMSigner(signer: SIWxSigner): boolean {
  // Check for Solana-specific properties first (to exclude them)
  // signMessages (plural) is only on @solana/kit signers
  if ("signMessages" in signer && typeof signer.signMessages === "function") {
    return false;
  }
  // Check for Solana wallet adapter publicKey (has toBase58 or is non-hex string)
  if ("publicKey" in signer && signer.publicKey) {
    const pk = signer.publicKey;
    if (typeof pk === "object" && pk !== null && "toBase58" in pk) {
      return false;
    }
    if (typeof pk === "string" && !pk.startsWith("0x")) {
      return false;
    }
  }
  // EVM signers have account.address or direct address property (hex format)
  if ("account" in signer && signer.account && typeof signer.account === "object") {
    const account = signer.account as { address?: string };
    if (account.address && account.address.startsWith("0x")) {
      return true;
    }
  }
  if (
    "address" in signer &&
    typeof signer.address === "string" &&
    signer.address.startsWith("0x")
  ) {
    return true;
  }
  return false;
}

/**
 * Get address from an EVM signer.
 *
 * @param signer - EVM wallet signer instance
 * @returns The wallet address as a hex string
 */
export function getEVMAddress(signer: EVMSigner): string {
  if (signer.account?.address) {
    return signer.account.address;
  }
  if (signer.address) {
    return signer.address;
  }
  throw new Error("EVM signer missing address");
}

/**
 * Sign a message with an EVM wallet.
 * Returns hex-encoded signature.
 *
 * @param message - The message to sign
 * @param signer - EVM wallet signer instance
 * @returns Hex-encoded signature
 */
export async function signEVMMessage(message: string, signer: EVMSigner): Promise<string> {
  if (signer.account) {
    return signer.signMessage({ message, account: signer.account });
  }
  return signer.signMessage({ message });
}

/**
 * Create an EVM SIWX payload after checking the challenge origin.
 *
 * @param serverExtension - Server extension info with the selected EVM chain
 * @param signer - EVM wallet signer
 * @param requestUrl - Final URL of the 402 response after redirects
 * @returns Complete SIWX payload with signature
 */
export async function createEVMPayload(
  serverExtension: CompleteSIWxInfo,
  signer: EVMSigner,
  requestUrl: string | URL,
): Promise<SIWxPayload> {
  assertSIWxChallengeBoundToOrigin(serverExtension, requestUrl);
  const address = getEVMAddress(signer);
  const message = formatSIWEMessage(serverExtension, address);
  const signature = await signEVMMessage(message, signer);
  return buildSIWxPayload(serverExtension, address, signature);
}

/**
 * Verify EVM signature with optional smart wallet support.
 *
 * @param payload - The SIWX payload containing signature and message data
 * @param options - Optional verification options for EIP-1271/EIP-6492 support
 * @returns Verification result with recovered address if valid
 */
export async function verifyEVMPayload(
  payload: SIWxPayload,
  options?: SIWxVerifyOptions,
): Promise<SIWxVerifyResult> {
  try {
    extractEVMChainId(payload.chainId);
  } catch (error) {
    return {
      isValid: false,
      invalidReason: "invalid_siwx_chain_id",
      invalidMessage: error instanceof Error ? error.message : "Invalid EVM chainId format",
    };
  }

  const message = formatSIWEMessage(payload, payload.address);

  try {
    const valid = await verifyEVMSignature(
      message,
      payload.address,
      payload.signature,
      options?.evmVerifier,
    );

    if (!valid) {
      return {
        isValid: false,
        invalidReason: "invalid_siwx_signature",
        invalidMessage: "Signature verification failed",
      };
    }

    return {
      isValid: true,
      payer: payload.address,
    };
  } catch (error) {
    return {
      isValid: false,
      invalidReason: "invalid_siwx_verifier_error",
      invalidMessage: error instanceof Error ? error.message : "Signature verification failed",
    };
  }
}
