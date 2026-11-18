/**
 * Validation and extraction utilities for the Payment-Identifier Extension
 */

import Ajv from "ajv/dist/2020.js";
import type { PaymentPayload } from "@x402/core/types";
import type { PaymentIdentifierExtension, PaymentIdentifierInfo } from "./types";
import { PAYMENT_IDENTIFIER } from "./types";
import { paymentIdentifierSchema } from "./schema";
import { isValidPaymentId } from "./utils";

/**
 * Type guard to check if an object is a valid payment-identifier extension structure.
 *
 * This checks for the basic structure (info object with required boolean),
 * but does not validate the id format if present.
 *
 * @param extension - The object to check
 * @returns True if the object has the expected payment-identifier extension structure
 *
 * @example
 * ```typescript
 * if (isPaymentIdentifierExtension(extensions["payment-identifier"])) {
 *   // TypeScript knows this is PaymentIdentifierExtension
 *   console.log(extension.info.required);
 * }
 * ```
 */
export function isPaymentIdentifierExtension(
  extension: unknown,
): extension is PaymentIdentifierExtension {
  if (!extension || typeof extension !== "object") {
    return false;
  }

  const ext = extension as Partial<PaymentIdentifierExtension>;

  if (!ext.info || typeof ext.info !== "object") {
    return false;
  }

  const info = ext.info as Partial<PaymentIdentifierInfo>;

  // Must have required boolean
  if (typeof info.required !== "boolean") {
    return false;
  }

  return true;
}

/**
 * Result of payment identifier validation
 */
export interface PaymentIdentifierValidationResult {
  /**
   * Whether the payment identifier is valid
   */
  valid: boolean;

  /**
   * Error messages if validation failed
   */
  errors?: string[];
}

/**
 * Validates a payment-identifier extension object.
 *
 * Checks both the structure (using JSON Schema) and the ID format.
 *
 * @param extension - The extension object to validate
 * @returns Validation result with errors if invalid
 *
 * @example
 * ```typescript
 * const result = validatePaymentIdentifier(paymentPayload.extensions?.["payment-identifier"]);
 * if (!result.valid) {
 *   console.error("Invalid payment identifier:", result.errors);
 * }
 * ```
 */
export function validatePaymentIdentifier(extension: unknown): PaymentIdentifierValidationResult {
  if (!extension || typeof extension !== "object") {
    return {
      valid: false,
      errors: ["Extension must be an object"],
    };
  }

  const ext = extension as Partial<PaymentIdentifierExtension>;

  // Check info exists
  if (!ext.info || typeof ext.info !== "object") {
    return {
      valid: false,
      errors: ["Extension must have an 'info' property"],
    };
  }

  const info = ext.info as Partial<PaymentIdentifierInfo>;

  // Check required field exists and is a boolean
  if (typeof info.required !== "boolean") {
    return {
      valid: false,
      errors: ["Extension info must have a 'required' boolean property"],
    };
  }

  // Check id exists and is a string (if provided)
  if (info.id !== undefined && typeof info.id !== "string") {
    return {
      valid: false,
      errors: ["Extension info 'id' must be a string if provided"],
    };
  }

  // Validate ID format if provided
  if (info.id !== undefined && !isValidPaymentId(info.id)) {
    return {
      valid: false,
      errors: [
        `Invalid payment ID format. ID must be 16-128 characters and contain only alphanumeric characters, hyphens, and underscores.`,
      ],
    };
  }

  // If schema is provided, validate against it
  if (ext.schema) {
    try {
      const ajv = new Ajv({ strict: false, allErrors: true });
      const validate = ajv.compile(ext.schema);
      const valid = validate(ext.info);

      if (!valid && validate.errors) {
        const errors = validate.errors?.map(err => {
          const path = err.instancePath || "(root)";
          return `${path}: ${err.message}`;
        }) || ["Unknown validation error"];

        return { valid: false, errors };
      }
    } catch (error) {
      return {
        valid: false,
        errors: [
          `Schema validation failed: ${error instanceof Error ? error.message : String(error)}`,
        ],
      };
    }
  }

  return { valid: true };
}

/**
 * Extracts the payment identifier from a PaymentPayload.
 *
 * @param paymentPayload - The payment payload to extract from
 * @param validate - Whether to validate the ID before returning (default: true)
 * @returns The payment ID string, or null if not present or invalid
 *
 * @example
 * ```typescript
 * const id = extractPaymentIdentifier(paymentPayload);
 * if (id) {
 *   // Use for idempotency lookup
 *   const cached = await idempotencyStore.get(id);
 * }
 * ```
 */
export function extractPaymentIdentifier(
  paymentPayload: PaymentPayload,
  validate: boolean = true,
): string | null {
  if (!paymentPayload.extensions) {
    return null;
  }

  const extension = paymentPayload.extensions[PAYMENT_IDENTIFIER];

  if (!extension || typeof extension !== "object") {
    return null;
  }

  const ext = extension as Partial<PaymentIdentifierExtension>;

  if (!ext.info || typeof ext.info !== "object") {
    return null;
  }

  const info = ext.info as Partial<PaymentIdentifierInfo>;

  if (typeof info.id !== "string") {
    return null;
  }

  if (validate && !isValidPaymentId(info.id)) {
    return null;
  }

  return info.id;
}

/**
 * Extracts and validates the payment identifier from a PaymentPayload.
 *
 * @param paymentPayload - The payment payload to extract from
 * @returns Object with the ID and validation result
 *
 * @example
 * ```typescript
 * const { id, validation } = extractAndValidatePaymentIdentifier(paymentPayload);
 * if (!validation.valid) {
 *   return res.status(400).json({ error: validation.errors });
 * }
 * if (id) {
 *   // Use for idempotency
 * }
 * ```
 */
export function extractAndValidatePaymentIdentifier(paymentPayload: PaymentPayload): {
  id: string | null;
  validation: PaymentIdentifierValidationResult;
} {
  if (!paymentPayload.extensions) {
    return { id: null, validation: { valid: true } };
  }

  const extension = paymentPayload.extensions[PAYMENT_IDENTIFIER];

  if (!extension) {
    return { id: null, validation: { valid: true } };
  }

  const validation = validatePaymentIdentifier(extension);

  if (!validation.valid) {
    return { id: null, validation };
  }

  const ext = extension as PaymentIdentifierExtension;
  return { id: ext.info.id ?? null, validation: { valid: true } };
}

/**
 * Checks if a PaymentPayload contains a payment-identifier extension.
 *
 * @param paymentPayload - The payment payload to check
 * @returns True if the extension is present
 */
export function hasPaymentIdentifier(paymentPayload: PaymentPayload): boolean {
  return !!(paymentPayload.extensions && paymentPayload.extensions[PAYMENT_IDENTIFIER]);
}

/**
 * Checks if the server requires a payment identifier based on the extension info.
 *
 * @param extension - The payment-identifier extension from PaymentRequired or PaymentPayload
 * @returns True if the server requires a payment identifier
 */
export function isPaymentIdentifierRequired(extension: unknown): boolean {
  if (!extension || typeof extension !== "object") {
    return false;
  }

  const ext = extension as Partial<PaymentIdentifierExtension>;

  if (!ext.info || typeof ext.info !== "object") {
    return false;
  }

  return (ext.info as Partial<PaymentIdentifierInfo>).required === true;
}

/**
 * Validates that a payment identifier is provided when required.
 *
 * Use this to check if a client's PaymentPayload satisfies the server's requirement.
 *
 * @param paymentPayload - The client's payment payload
 * @param serverRequired - Whether the server requires a payment identifier (from PaymentRequired)
 * @returns Validation result - invalid if required but not provided
 *
 * @example
 * ```typescript
 * const serverExtension = paymentRequired.extensions?.["payment-identifier"];
 * const serverRequired = isPaymentIdentifierRequired(serverExtension);
 * const result = validatePaymentIdentifierRequirement(paymentPayload, serverRequired);
 * if (!result.valid) {
 *   return res.status(400).json({ error: result.errors });
 * }
 * ```
 */
export function validatePaymentIdentifierRequirement(
  paymentPayload: PaymentPayload,
  serverRequired: boolean,
): PaymentIdentifierValidationResult {
  if (!serverRequired) {
    return { valid: true };
  }

  const id = extractPaymentIdentifier(paymentPayload, false);

  if (!id) {
    return {
      valid: false,
      errors: ["Server requires a payment identifier but none was provided"],
    };
  }

  // Validate the ID format
  if (!isValidPaymentId(id)) {
    return {
      valid: false,
      errors: [
        `Invalid payment ID format. ID must be 16-128 characters and contain only alphanumeric characters, hyphens, and underscores.`,
      ],
    };
  }

  return { valid: true };
}

export { paymentIdentifierSchema };
