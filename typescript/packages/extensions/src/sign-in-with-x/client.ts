/**
 * Complete client flow for SIWX extension
 *
 * Combines message construction, signing, and payload creation.
 * Supports both EVM and Solana wallets.
 */

import type { SIWxPayload } from "./types";
import type { CompleteSIWxInfo } from "./client-common";
import { assertSIWxChallengeBoundToOrigin, buildSIWxPayload } from "./client-common";
import type { SIWxSigner, EVMSigner, SolanaSigner } from "./sign";
import { getEVMAddress, getSolanaAddress, signEVMMessage, signSolanaMessage } from "./sign";
import { createSIWxMessage } from "./message";

export type { CompleteSIWxInfo } from "./client-common";
export { assertSIWxChallengeBoundToOrigin } from "./client-common";

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

  return buildSIWxPayload(serverExtension, address, signature);
}
