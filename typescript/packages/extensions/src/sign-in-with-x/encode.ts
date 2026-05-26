/**
 * Header encoding for SIWX extension
 *
 * Encodes SIWX payload for the SIGN-IN-WITH-X HTTP header.
 * Per CHANGELOG-v2.md line 335: header should be base64-encoded.
 */

import { safeBase64Encode } from "@x402/core/utils";
import type { SIWxPayload } from "./types";

/**
 * Encode SIWX payload for SIGN-IN-WITH-X header.
 *
 * Uses base64 encoding per x402 v2 spec (CHANGELOG-v2.md line 335).
 *
 * @param payload - Complete SIWX payload with signature
 * @returns Base64-encoded JSON string
 *
 * @example
 * ```typescript
 * const payload = await createSIWxPayload(serverInfo, signer);
 * const header = encodeSIWxHeader(payload);
 *
 * fetch(url, {
 *   headers: { 'SIGN-IN-WITH-X': header }
 * });
 * ```
 */
export function encodeSIWxHeader(payload: SIWxPayload): string {
  return safeBase64Encode(JSON.stringify(payload));
}
