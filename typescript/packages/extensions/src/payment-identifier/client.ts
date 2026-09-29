/**
 * Client-side utilities for the Payment-Identifier Extension
 */

import { PAYMENT_IDENTIFIER } from "./types";
import { generatePaymentId, isValidPaymentId } from "./utils";
import { isPaymentIdentifierExtension } from "./validation";

/**
 * Appends a payment identifier to the extensions object if the server declared support.
 *
 * This function reads the server's `payment-identifier` declaration from the extensions,
 * and appends the client's ID to it. If the extension is not present (server didn't declare it),
 * the extensions are returned unchanged.
 *
 * @param extensions - The extensions object from PaymentRequired (will be modified in place)
 * @param id - Optional custom payment ID. If not provided, a new ID will be generated.
 * @returns The modified extensions object (same reference as input)
 * @throws Error if the provided ID is invalid
 *
 * @example
 * ```typescript
 * import { appendPaymentIdentifierToExtensions } from '@x402/extensions/payment-identifier';
 *
 * // Get extensions from server's PaymentRequired response
 * const extensions = paymentRequired.extensions ?? {};
 *
 * // Append a generated ID (only if server declared payment-identifier)
 * appendPaymentIdentifierToExtensions(extensions);
 *
 * // Or use a custom ID
 * appendPaymentIdentifierToExtensions(extensions, "pay_my_custom_id_12345");
 *
 * // Include in PaymentPayload
 * const paymentPayload = {
 *   x402Version: 2,
 *   resource: paymentRequired.resource,
 *   accepted: selectedPaymentOption,
 *   payload: { ... },
 *   extensions
 * };
 * ```
 */
export function appendPaymentIdentifierToExtensions(
  extensions: Record<string, unknown>,
  id?: string,
): Record<string, unknown> {
  const extension = extensions[PAYMENT_IDENTIFIER];

  // Only append if the server declared this extension with valid structure
  if (!isPaymentIdentifierExtension(extension)) {
    return extensions;
  }

  const paymentId = id ?? generatePaymentId();

  if (!isValidPaymentId(paymentId)) {
    throw new Error(
      `Invalid payment ID: "${paymentId}". ` +
        `ID must be 16-128 characters and contain only alphanumeric characters, hyphens, and underscores.`,
    );
  }

  // Append the ID to the existing extension info
  extension.info.id = paymentId;

  return extensions;
}
