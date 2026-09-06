/**
 * Resource Server utilities for the Payment-Identifier Extension
 */

import type { ResourceServerExtension } from "@x402/core/types";
import type { PaymentIdentifierExtension } from "./types";
import { PAYMENT_IDENTIFIER } from "./types";
import { paymentIdentifierSchema } from "./schema";

/**
 * Declares the payment-identifier extension for inclusion in PaymentRequired.extensions.
 *
 * Resource servers call this function to advertise support for payment identifiers.
 * The declaration indicates whether a payment identifier is required and includes
 * the schema that clients must follow.
 *
 * @param required - Whether clients must provide a payment identifier. Defaults to false.
 * @returns A PaymentIdentifierExtension object ready for PaymentRequired.extensions
 *
 * @example
 * ```typescript
 * import { declarePaymentIdentifierExtension, PAYMENT_IDENTIFIER } from '@x402/extensions/payment-identifier';
 *
 * // Include in PaymentRequired response (optional identifier)
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
 */
export function declarePaymentIdentifierExtension(
  required: boolean = false,
): PaymentIdentifierExtension {
  return {
    info: { required },
    schema: paymentIdentifierSchema,
  };
}

/**
 * ResourceServerExtension implementation for payment-identifier.
 *
 * This extension doesn't require any enrichment hooks since the declaration
 * is static. It's provided for consistency with other extensions and for
 * potential future use with the extension registration system.
 *
 * @example
 * ```typescript
 * import { paymentIdentifierResourceServerExtension } from '@x402/extensions/payment-identifier';
 *
 * resourceServer.registerExtension(paymentIdentifierResourceServerExtension);
 * ```
 */
export const paymentIdentifierResourceServerExtension: ResourceServerExtension = {
  key: PAYMENT_IDENTIFIER,

  // No enrichment needed - the declaration is static
  // Future hooks for idempotency could be added here if needed
};
