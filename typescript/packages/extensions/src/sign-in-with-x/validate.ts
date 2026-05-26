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
 * - Domain binding: domain MUST match server's domain
 * - URI validation: uri must refer to base url of resource
 * - Temporal validation:
 *   - issuedAt MUST be recent (< 5 minutes by default)
 *   - expirationTime MUST be in the future
 *   - notBefore (if present) MUST be in the past
 * - Nonce: MUST be unique (via optional checkNonce callback)
 *
 * @param message - The SIWX payload to validate
 * @param expectedResourceUri - Expected resource URI (for domain/URI matching)
 * @param options - Validation options
 * @returns Validation result
 *
 * @example
 * ```typescript
 * const payload = parseSIWxHeader(header);
 * const result = await validateSIWxMessage(
 *   payload,
 *   'https://api.example.com/data',
 *   { checkNonce: (n) => !usedNonces.has(n) }
 * );
 *
 * if (!result.valid) {
 *   return { error: result.error };
 * }
 * ```
 */
export async function validateSIWxMessage(
  message: SIWxPayload,
  expectedResourceUri: string,
  options: SIWxValidationOptions = {},
): Promise<SIWxValidationResult> {
  const expectedUrl = new URL(expectedResourceUri);
  const maxAge = options.maxAge ?? DEFAULT_MAX_AGE_MS;

  // 1. Domain binding (spec: "domain field MUST match server's domain")
  // Use hostname (without port) per EIP-4361 convention
  if (message.domain !== expectedUrl.hostname) {
    return {
      valid: false,
      error: `Domain mismatch: expected "${expectedUrl.hostname}", got "${message.domain}"`,
    };
  }

  // 2. URI validation (spec: "uri and resources must refer to base url of resource")
  // Allow the message URI to be the origin or the full resource URL
  if (!message.uri.startsWith(expectedUrl.origin)) {
    return {
      valid: false,
      error: `URI mismatch: expected origin "${expectedUrl.origin}", got "${message.uri}"`,
    };
  }

  // 3. issuedAt validation (spec: "MUST be recent, recommended < 5 minutes")
  const issuedAt = new Date(message.issuedAt);
  if (isNaN(issuedAt.getTime())) {
    return {
      valid: false,
      error: "Invalid issuedAt timestamp",
    };
  }

  const age = Date.now() - issuedAt.getTime();
  if (age > maxAge) {
    return {
      valid: false,
      error: `Message too old: ${Math.round(age / 1000)}s exceeds ${maxAge / 1000}s limit`,
    };
  }
  if (age < 0) {
    return {
      valid: false,
      error: "issuedAt is in the future",
    };
  }

  // 4. expirationTime validation (spec: "MUST be in the future")
  if (message.expirationTime) {
    const expiration = new Date(message.expirationTime);
    if (isNaN(expiration.getTime())) {
      return {
        valid: false,
        error: "Invalid expirationTime timestamp",
      };
    }
    if (expiration < new Date()) {
      return {
        valid: false,
        error: "Message expired",
      };
    }
  }

  // 5. notBefore validation (spec: "if present, MUST be in the past")
  if (message.notBefore) {
    const notBefore = new Date(message.notBefore);
    if (isNaN(notBefore.getTime())) {
      return {
        valid: false,
        error: "Invalid notBefore timestamp",
      };
    }
    if (new Date() < notBefore) {
      return {
        valid: false,
        error: "Message not yet valid (notBefore is in the future)",
      };
    }
  }

  // 6. Nonce validation (spec: "MUST be unique per session to prevent replay attacks")
  if (options.checkNonce) {
    const nonceValid = await options.checkNonce(message.nonce);
    if (!nonceValid) {
      return {
        valid: false,
        error: "Nonce validation failed (possible replay attack)",
      };
    }
  }

  return { valid: true };
}
