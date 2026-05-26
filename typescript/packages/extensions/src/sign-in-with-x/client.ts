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
 * Create a complete SIWX payload from server extension info with selected chain.
 *
 * Routes to EVM or Solana signing based on the chainId prefix:
 * - `eip155:*` → EVM signing
 * - `solana:*` → Solana signing
 *
 * @param serverExtension - Server extension info with chain selected (includes chainId, type)
 * @param signer - Wallet that can sign messages (EVMSigner or SolanaSigner)
 * @returns Complete SIWX payload with signature
 *
 * @example
 * ```typescript
 * // EVM wallet
 * const completeInfo = { ...extension.info, chainId: "eip155:8453", type: "eip191" };
 * const payload = await createSIWxPayload(completeInfo, evmWallet);
 * ```
 */
export async function createSIWxPayload(
  serverExtension: CompleteSIWxInfo,
  signer: SIWxSigner,
): Promise<SIWxPayload> {
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
