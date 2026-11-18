/**
 * Message validation for SIWX extension
 *
 * Validates SIWX payload fields before cryptographic verification.
 * Per CHANGELOG-v2.md validation rules (lines 318-329).
 */

import type { SIWxPayload, SIWxValidationResult, SIWxValidationOptions } from "./types";

/** Default maximum age for issuedAt: 5 minutes per spec */
const DEFAULT_MAX_AGE_MS = 5 * 60 * 1000;

/**
 * Validate SIWX message fields.
 *
 * Performs validation per spec (CHANGELOG-v2.md lines 318-329):
 * - Domain binding: domain MUST match configured origin host
 * - URI validation: uri origin MUST exactly match configured origin
 * - Temporal validation:
 *   - issuedAt MUST be recent (< 5 minutes by default)
 *   - expirationTime MUST be in the future
 *   - notBefore (if present) MUST be in the past
 * - Nonce: MUST be unique (via optional checkNonce callback)
 *
 * @param message - The SIWX payload to validate
 * @param expectedOrigin - Configured public origin for domain/URI matching
 * @param options - Validation options
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const payload = parseSIWxHeader(header);
 * const result = await validateSIWxMessage(
 *   payload,
 *   new URL('https://api.example.com'),
 *   { checkNonce: (n) => !usedNonces.has(n) }
 * );
 *
 * if (!result.isValid) {
 *   return { error: result.invalidMessage };
 * }
 * ```
 */
export async function validateSIWxMessage(
  message: SIWxPayload,
  expectedOrigin: URL,
  options: SIWxValidationOptions = {},
): Promise<SIWxValidationResult> {
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE_MS;

  // 1. Domain binding (spec: "domain field MUST match server's domain")
  if (message.domain !== expectedOrigin.host) {
    return {
      isValid: false,
      invalidReason: "invalid_siwx_domain_mismatch",
      invalidMessage: `Domain mismatch: expected "${expectedOrigin.host}", got "${message.domain}"`,
    };
  }

  // 2. URI validation (spec: "uri and resources must refer to base url of resource")
  let messageUri: URL;
  try {
    messageUri = new URL(message.uri);
  } catch {
    return {
      isValid: false,
      invalidReason: "invalid_siwx_uri_mismatch",
      invalidMessage: `Invalid URI: "${message.uri}" is not a valid URL`,
    };
  }

  if (messageUri.origin !== expectedOrigin.origin) {
    return {
      isValid: false,
      invalidReason: "invalid_siwx_uri_mismatch",
      invalidMessage: `URI mismatch: expected origin "${expectedOrigin.origin}", got "${messageUri.origin}"`,
    };
  }

  // 3. issuedAt validation (spec: "MUST be recent, recommended < 5 minutes")
  const issuedAt = new Date(message.issuedAt);
  if (isNaN(issuedAt.getTime())) {
    return {
      isValid: false,
      invalidReason: "invalid_siwx_issued_at",
      invalidMessage: "Invalid issuedAt timestamp",
    };
  }

  const age = Date.now() - issuedAt.getTime();
  if (age > maxAge) {
    return {
      isValid: false,
      invalidReason: "invalid_siwx_issued_at_too_old",
      invalidMessage: `Message too old: ${Math.round(age / 1000)}s exceeds ${maxAge / 1000}s limit`,
    };
  }
  if (age < 0) {
    return {
      isValid: false,
      invalidReason: "invalid_siwx_issued_at_in_future",
      invalidMessage: "issuedAt is in the future",
    };
  }

  // 4. expirationTime validation (spec: "MUST be in the future")
  if (message.expirationTime) {
    const expiration = new Date(message.expirationTime);
    if (isNaN(expiration.getTime())) {
      return {
        isValid: false,
        invalidReason: "invalid_siwx_expiration_time",
        invalidMessage: "Invalid expirationTime timestamp",
      };
    }
    if (expiration < new Date()) {
      return {
        isValid: false,
        invalidReason: "invalid_siwx_expired",
        invalidMessage: "Message expired",
      };
    }
  }

  // 5. notBefore validation (spec: "if present, MUST be in the past")
  if (message.notBefore) {
    const notBefore = new Date(message.notBefore);
    if (isNaN(notBefore.getTime())) {
      return {
        isValid: false,
        invalidReason: "invalid_siwx_not_before",
        invalidMessage: "Invalid notBefore timestamp",
      };
    }
    if (new Date() < notBefore) {
      return {
        isValid: false,
        invalidReason: "invalid_siwx_not_yet_valid",
        invalidMessage: "Message not yet valid (notBefore is in the future)",
      };
    }
  }

  // 6. Nonce validation (spec: "MUST be unique per session to prevent replay attacks")
  if (options.checkNonce) {
    const nonceValid = await options.checkNonce(message.nonce);
    if (!nonceValid) {
      return {
        isValid: false,
        invalidReason: "invalid_siwx_nonce",
        invalidMessage: "Nonce validation failed (possible replay attack)",
      };
    }
  }

  return { isValid: true };
}
