import type { SIWxExtensionInfo, SIWxPayload, SignatureType, SignatureScheme } from "./types";

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
 * Select the signed proof fields from a server challenge.
 *
 * @param serverExtension - Server extension info with the selected chain
 * @param address - Signer address
 * @param signature - Encoded signature
 * @returns Complete SIWX payload
 */
export function buildSIWxPayload(
  serverExtension: CompleteSIWxInfo,
  address: string,
  signature: string,
): SIWxPayload {
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
