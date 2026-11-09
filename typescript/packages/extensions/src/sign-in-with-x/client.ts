/**
 * Complete client flow for SIWX extension
 *
 * Combines message construction, signing, and payload creation.
 * Supports both EVM and Solana wallets.
 */

import type { SIWxExtensionInfo, SIWxPayload, SignatureType, SignatureScheme } from "./types";
import type { SIWxSigner, EVMSigner, SolanaSigner } from "./sign";
import { getEVMAddress, getSolanaAddress, signEVMMessage, signSolanaMessage } from "./sign";
import { createSIWxMessage } from "./message";

/**
 * Complete SIWX info with chain-specific fields.
 * Used by utility functions that need the selected chain information.
 */
export type CompleteSIWxInfo = SIWxExtensionInfo & {
  chainId: string;
  type: SignatureType;
  signatureScheme?: SignatureScheme;
};

/**
 * Verifies that a SIWX challenge is bound to the origin of the resource that issued the 402.
 *
 * Checks `domain` and `uri` only. EIP-4361 `resources` may be cross-origin URIs and are not
 * validated here (matching server-side validateSIWxMessage).
 *
 * @param info - Server extension info from the 402 response
 * @param responseUrl - Final URL of the 402 response (after redirects)
 * @throws Error when domain or uri origin does not match
 */
export function assertSIWxChallengeBoundToOrigin(
  info: SIWxExtensionInfo,
  responseUrl: string | URL,
): void {
  const origin = typeof responseUrl === "string" ? new URL(responseUrl) : responseUrl;

  if (info.domain !== origin.host) {
    throw new Error(
      `SIWX challenge domain "${info.domain}" does not match response origin host "${origin.host}"`,
    );
  }

  let uriOrigin: string;
  try {
    uriOrigin = new URL(info.uri).origin;
  } catch {
    throw new Error(`SIWX challenge uri "${info.uri}" is not a valid URL`);
  }

  if (uriOrigin !== origin.origin) {
    throw new Error(
      `SIWX challenge uri origin "${uriOrigin}" does not match response origin "${origin.origin}"`,
    );
  }
}

/**
 * Create a complete SIWX payload from server extension info with selected chain.
 *
 * Routes to EVM or Solana signing based on the chainId prefix:
 * - `eip155:*` → EVM signing
 * - `solana:*` → Solana signing
 *
 * @param serverExtension - Server extension info with chain selected (includes chainId, type)
 * @param signer - Wallet that can sign messages (EVMSigner or SolanaSigner)
 * @param requestUrl - Final URL of the 402 response (after redirects)
 * @returns Complete SIWX payload with signature
 *
 * @example
 * ```typescript
 * // EVM wallet
 * const completeInfo = { ...extension.info, chainId: "eip155:8453", type: "eip191" };
 * const payload = await createSIWxPayload(completeInfo, evmWallet, response.url);
 * ```
 */
export async function createSIWxPayload(
  serverExtension: CompleteSIWxInfo,
  signer: SIWxSigner,
  requestUrl: string | URL,
): Promise<SIWxPayload> {
  assertSIWxChallengeBoundToOrigin(serverExtension, requestUrl);

  const isSolana = serverExtension.chainId.startsWith("solana:");

  // Get address and sign based on chain type
  const address = isSolana
    ? getSolanaAddress(signer as SolanaSigner)
    : getEVMAddress(signer as EVMSigner);

  const message = createSIWxMessage(serverExtension, address);

  const signature = isSolana
    ? await signSolanaMessage(message, signer as SolanaSigner)
    : await signEVMMessage(message, signer as EVMSigner);

  return {
    domain: serverExtension.domain,
    address,
    statement: serverExtension.statement,
    uri: serverExtension.uri,
    version: serverExtension.version,
    chainId: serverExtension.chainId,
    type: serverExtension.type,
    nonce: serverExtension.nonce,
    issuedAt: serverExtension.issuedAt,
    expirationTime: serverExtension.expirationTime,
    notBefore: serverExtension.notBefore,
    requestId: serverExtension.requestId,
    resources: serverExtension.resources,
    signatureScheme: serverExtension.signatureScheme,
    signature,
  };
}
