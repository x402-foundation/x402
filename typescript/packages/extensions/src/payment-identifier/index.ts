/**
 * Payment-Identifier Extension for x402 v2
 *
 * Enables clients to provide an idempotency key (`id`) that resource servers
 * can use for deduplication of payment requests.
 *
 * ## Usage
 *
 * ### For Resource Servers
 *
 * ```typescript
 * import {
 *   declarePaymentIdentifierExtension,
 *   PAYMENT_IDENTIFIER
 * } from '@x402/extensions/payment-identifier';
 *
 * // Advertise support in PaymentRequired response (optional identifier)
 * const paymentRequired = {
 *   x402Version: 2,
 *   resource: { ... },
 *   accepts: [ ... ],
 *   extensions: {
 *     [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension()
 *   }
 * };
 *
 * // Require payment identifier
 * const paymentRequiredStrict = {
 *   x402Version: 2,
 *   resource: { ... },
 *   accepts: [ ... ],
 *   extensions: {
 *     [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true)
 *   }
 * };
 * ```
 *
 * ### For Clients
 *
 * ```typescript
 * import { appendPaymentIdentifierToExtensions } from '@x402/extensions/payment-identifier';
 *
 * // Get extensions from server's PaymentRequired response
 * const extensions = { ...paymentRequired.extensions };
 *
 * // Append payment ID (only if server declared the extension)
 * appendPaymentIdentifierToExtensions(extensions);
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
 *
 * ### For Idempotency Implementation
 *
 * ```typescript
 * import { extractPaymentIdentifier } from '@x402/extensions/payment-identifier';
 *
 * // In your settle handler
 * const id = extractPaymentIdentifier(paymentPayload);
 * if (id) {
 *   const cached = await idempotencyStore.get(id);
 *   if (cached) {
 *     return cached; // Return cached response
 *   }
 * }
 * ```
 */

// Export types
export type {
  PaymentIdentifierInfo,
  PaymentIdentifierExtension,
  PaymentIdentifierSchema,
} from "./types";

export {
  PAYMENT_IDENTIFIER,
  PAYMENT_ID_MIN_LENGTH,
  PAYMENT_ID_MAX_LENGTH,
  PAYMENT_ID_PATTERN,
} from "./types";

// Export schema
export { paymentIdentifierSchema } from "./schema";

// Export utilities
export { generatePaymentId, isValidPaymentId } from "./utils";

// Export client functions
export { appendPaymentIdentifierToExtensions } from "./client";

// Export resource server functions
export {
  declarePaymentIdentifierExtension,
  paymentIdentifierResourceServerExtension,
} from "./resourceServer";

// Export validation and extraction functions
export {
  isPaymentIdentifierExtension,
  validatePaymentIdentifier,
  extractPaymentIdentifier,
  extractAndValidatePaymentIdentifier,
  hasPaymentIdentifier,
  isPaymentIdentifierRequired,
  validatePaymentIdentifierRequirement,
  type PaymentIdentifierValidationResult,
} from "./validation";
