/**
 * Utility functions for the Payment-Identifier Extension
 */

import { PAYMENT_ID_MIN_LENGTH, PAYMENT_ID_MAX_LENGTH, PAYMENT_ID_PATTERN } from "./types";

/**
 * Generates a unique payment identifier.
 *
 * @param prefix - Optional prefix for the ID (e.g., "pay_"). Defaults to "pay_".
 * @returns A unique payment identifier string
 *
 * @example
 * ```typescript
 * // With default prefix
 * const id = generatePaymentId(); // "pay_7d5d747be160e280504c099d984bcfe0"
 *
 * // With custom prefix
 * const id = generatePaymentId("txn_"); // "txn_7d5d747be160e280504c099d984bcfe0"
 *
 * // Without prefix
 * const id = generatePaymentId(""); // "7d5d747be160e280504c099d984bcfe0"
 * ```
 */
export function generatePaymentId(prefix: string = "pay_"): string {
  // Generate UUID v4 without hyphens (32 hex chars)
  const uuid = crypto.randomUUID().replace(/-/g, "");
  return `${prefix}${uuid}`;
}

/**
 * Validates that a payment ID meets the format requirements.
 *
 * @param id - The payment ID to validate
 * @returns True if the ID is valid, false otherwise
 *
 * @example
 * ```typescript
 * isValidPaymentId("pay_7d5d747be160e280"); // true (exactly 16 chars after prefix removal check)
 * isValidPaymentId("abc"); // false (too short)
 * isValidPaymentId("pay_abc!@#"); // false (invalid characters)
 * ```
 */
export function isValidPaymentId(id: string): boolean {
  if (typeof id !== "string") {
    return false;
  }

  if (id.length < PAYMENT_ID_MIN_LENGTH || id.length > PAYMENT_ID_MAX_LENGTH) {
    return false;
  }

  return PAYMENT_ID_PATTERN.test(id);
}
