/**
 * Type definitions for the Payment-Identifier Extension
 *
 * Enables clients to provide an idempotency key that resource servers
 * can use for deduplication of payment requests.
 */

/**
 * Extension identifier constant for the payment-identifier extension
 */
export const PAYMENT_IDENTIFIER = "payment-identifier";

/**
 * Minimum length for payment identifier
 */
export const PAYMENT_ID_MIN_LENGTH = 16;

/**
 * Maximum length for payment identifier
 */
export const PAYMENT_ID_MAX_LENGTH = 128;

/**
 * Pattern for valid payment identifier characters (alphanumeric, hyphens, underscores)
 */
export const PAYMENT_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Payment identifier info containing the required flag and client-provided ID
 */
export interface PaymentIdentifierInfo {
  /**
   * Whether the server requires clients to include a payment identifier.
   * When true, clients must provide an `id` or receive a 400 Bad Request.
   */
  required: boolean;

  /**
   * Client-provided unique identifier for idempotency.
   * Must be 16-128 characters, alphanumeric with hyphens and underscores allowed.
   */
  id?: string;
}

/**
 * Payment identifier extension with info and schema.
 *
 * Used both for server-side declarations (info without id) and
 * client-side payloads (info with id).
 */
export interface PaymentIdentifierExtension {
  /**
   * The payment identifier info.
   * Server declarations have required only, clients add the id.
   */
  info: PaymentIdentifierInfo;

  /**
   * JSON Schema validating the info structure
   */
  schema: PaymentIdentifierSchema;
}

/**
 * JSON Schema type for the payment-identifier extension
 */
export interface PaymentIdentifierSchema {
  $schema: "https://json-schema.org/draft/2020-12/schema";
  type: "object";
  properties: {
    required: {
      type: "boolean";
    };
    id: {
      type: "string";
      minLength: number;
      maxLength: number;
      pattern: string;
    };
  };
  required: ["required"];
}
