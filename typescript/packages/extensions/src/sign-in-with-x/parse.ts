/**
 * Header parsing for SIWX extension
 *
 * Parses the SIGN-IN-WITH-X header from client requests.
 * Requires base64-encoded JSON per x402 v2 spec.
 */

import { Base64EncodedRegex, safeBase64Decode } from "@x402/core/utils";
import { SIWxPayloadSchema, type SIWxPayload } from "./types";

/**
 * Parse SIGN-IN-WITH-X header into structured payload.
 *
 * Expects base64-encoded JSON per x402 v2 spec (CHANGELOG-v2.md line 335).
 *
 * @param header - The SIGN-IN-WITH-X header value (base64-encoded JSON)
 * @returns Parsed SIWX payload
 * @throws Error if header is invalid or missing required fields
 *
 * @example
 * ```typescript
 * const header = request.headers.get('SIGN-IN-WITH-X');
 * if (header) {
 *   const payload = parseSIWxHeader(header);
 *   // payload.address, payload.signature, etc.
 * }
 * ```
 */
export function parseSIWxHeader(header: string): SIWxPayload {
  if (!Base64EncodedRegex.test(header)) {
    throw new Error("Invalid SIWX header: not valid base64");
  }

  const jsonStr = safeBase64Decode(header);

  let rawPayload: unknown;
  try {
    rawPayload = JSON.parse(jsonStr);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Invalid SIWX header: not valid JSON");
    }
    throw error;
  }

  const parsed = SIWxPayloadSchema.safeParse(rawPayload);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(i => `${i.path.join(".")}: ${i.message}`).join(", ");
    throw new Error(`Invalid SIWX header: ${issues}`);
  }

  return parsed.data;
}
