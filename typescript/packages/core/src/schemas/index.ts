import { z } from "zod";

// ============================================================================
// Reusable Primitive Schemas
// ============================================================================

/**
 * Non-empty string schema - a string with at least one character.
 * Used for required string fields that cannot be empty.
 */
export const NonEmptyString = z.string().min(1);
export type NonEmptyString = z.infer<typeof NonEmptyString>;

/**
 * Any record schema - an object with unknown keys and values.
 * Used for scheme-specific payloads and other extensible objects.
 */
export const Any = z.record(z.unknown());
export type Any = z.infer<typeof Any>;

/**
 * Optional any record schema - an optional object with unknown keys and values.
 * Used for optional extension fields like `extra` and `extensions`.
 */
export const OptionalAny = z.record(z.unknown()).optional().nullable();
export type OptionalAny = z.infer<typeof OptionalAny>;

// ============================================================================
// Network Schemas
// ============================================================================

/**
 * Network identifier schema for V1 - loose validation.
 * V1 accepts any non-empty string for backwards compatibility.
 */
export const NetworkSchemaV1 = NonEmptyString;
export type NetworkV1 = z.infer<typeof NetworkSchemaV1>;

/**
 * Network identifier schema for V2 - CAIP-2 format validation.
 * V2 requires minimum length of 3 and a colon separator (e.g., "eip155:84532", "solana:devnet").
 */
export const NetworkSchemaV2 = z
  .string()
  .min(3)
  .refine(val => val.includes(":"), {
    message: "Network must be in CAIP-2 format (e.g., 'eip155:84532')",
  });
export type NetworkV2 = z.infer<typeof NetworkSchemaV2>;

/**
 * Union network schema - accepts either V1 or V2 format.
 */
export const NetworkSchema = z.union([NetworkSchemaV1, NetworkSchemaV2]);
export type Network = z.infer<typeof NetworkSchema>;

// ============================================================================
// Shared Schemas
// ============================================================================

/**
 * ResourceInfo schema for V2 - describes the protected resource.
 */
// Printable ASCII (U+0020–U+007E) — matches the bazaar-facilitator
// `isValidServiceName` / `sanitizeTags` regex. Constraining to ASCII keeps
// the length cap consistent across TS / Python / Go (where String.length /
// len() / len() otherwise diverge for multi-byte input).
const PRINTABLE_ASCII_REGEX = /^[\x20-\x7e]+$/;

export const ResourceInfoSchema = z.object({
  url: NonEmptyString,
  description: z.string().optional(),
  mimeType: z.string().optional(),
  serviceName: z.string().min(1).max(32).regex(PRINTABLE_ASCII_REGEX).optional(),
  tags: z.array(z.string().min(1).max(32).regex(PRINTABLE_ASCII_REGEX)).max(5).optional(),
  iconUrl: z.string().max(2048).optional(),
});
export type ResourceInfo = z.infer<typeof ResourceInfoSchema>;

// ============================================================================
// V1 Schemas
// ============================================================================

/**
 * PaymentRequirements schema for V1.
 * V1 includes resource info directly in the requirements object.
 */
export const PaymentRequirementsV1Schema = z.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV1,
  maxAmountRequired: NonEmptyString,
  resource: NonEmptyString, // URL string in V1
  description: z.string(),
  mimeType: z.string().optional(),
  outputSchema: Any.optional().nullable(),
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  asset: NonEmptyString,
  extra: OptionalAny,
});
export type PaymentRequirementsV1 = z.infer<typeof PaymentRequirementsV1Schema>;

/**
 * PaymentRequired (402 response) schema for V1.
 * Contains payment requirements when a resource requires payment.
 */
export const PaymentRequiredV1Schema = z.object({
  x402Version: z.literal(1),
  error: z.string().optional(),
  accepts: z.array(PaymentRequirementsV1Schema).min(1),
});
export type PaymentRequiredV1 = z.infer<typeof PaymentRequiredV1Schema>;

/**
 * PaymentPayload schema for V1.
 * Contains the payment data sent by the client.
 */
export const PaymentPayloadV1Schema = z.object({
  x402Version: z.literal(1),
  scheme: NonEmptyString,
  network: NetworkSchemaV1,
  payload: Any,
});
export type PaymentPayloadV1 = z.infer<typeof PaymentPayloadV1Schema>;

// ============================================================================
// V2 Schemas
// ============================================================================

/**
 * PaymentRequirements schema for V2.
 * V2 uses "amount" instead of "maxAmountRequired" and doesn't include resource info.
 */
export const PaymentRequirementsV2Schema = z.object({
  scheme: NonEmptyString,
  network: NetworkSchemaV2,
  amount: NonEmptyString,
  asset: NonEmptyString,
  payTo: NonEmptyString,
  maxTimeoutSeconds: z.number().positive(),
  extra: OptionalAny,
});
export type PaymentRequirementsV2 = z.infer<typeof PaymentRequirementsV2Schema>;

/**
 * PaymentRequired (402 response) schema for V2.
 * Contains payment requirements when a resource requires payment.
 */
export const PaymentRequiredV2Schema = z.object({
  x402Version: z.literal(2),
  error: z.string().optional(),
  resource: ResourceInfoSchema,
  accepts: z.array(PaymentRequirementsV2Schema).min(1),
  extensions: OptionalAny,
});
export type PaymentRequiredV2 = z.infer<typeof PaymentRequiredV2Schema>;

/**
 * PaymentPayload schema for V2.
 * Contains the payment data sent by the client.
 */
export const PaymentPayloadV2Schema = z.object({
  x402Version: z.literal(2),
  resource: ResourceInfoSchema.optional(),
  accepted: PaymentRequirementsV2Schema,
  payload: Any,
  extensions: OptionalAny,
});
export type PaymentPayloadV2 = z.infer<typeof PaymentPayloadV2Schema>;

// ============================================================================
// Union Schemas (V1 | V2)
// ============================================================================

/**
 * PaymentRequirements union schema - accepts either V1 or V2 format.
 * Use this when you need to handle both versions.
 */
export const PaymentRequirementsSchema = z.union([
  PaymentRequirementsV1Schema,
  PaymentRequirementsV2Schema,
]);
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

/**
 * PaymentRequired union schema - accepts either V1 or V2 format.
 * Uses discriminated union on x402Version for efficient parsing.
 */
export const PaymentRequiredSchema = z.discriminatedUnion("x402Version", [
  PaymentRequiredV1Schema,
  PaymentRequiredV2Schema,
]);
export type PaymentRequired = z.infer<typeof PaymentRequiredSchema>;

/**
 * PaymentPayload union schema - accepts either V1 or V2 format.
 * Uses discriminated union on x402Version for efficient parsing.
 */
export const PaymentPayloadSchema = z.discriminatedUnion("x402Version", [
  PaymentPayloadV1Schema,
  PaymentPayloadV2Schema,
]);
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;

// ============================================================================
// Validation Functions
// ============================================================================

/**
 * Validates a PaymentRequired object (V1 or V2).
 *
 * @param value - The value to validate
 * @returns A result object with success status and data or error
 */
export function parsePaymentRequired(
  value: unknown,
): z.SafeParseReturnType<unknown, PaymentRequired> {
  return PaymentRequiredSchema.safeParse(value);
}

/**
 * Validates a PaymentRequired object and throws on error.
 *
 * @param value - The value to validate
 * @returns The validated PaymentRequired
 * @throws ZodError if validation fails
 */
export function validatePaymentRequired(value: unknown): PaymentRequired {
  return PaymentRequiredSchema.parse(value);
}

/**
 * Type guard for PaymentRequired (V1 or V2).
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentRequired
 */
export function isPaymentRequired(value: unknown): value is PaymentRequired {
  return PaymentRequiredSchema.safeParse(value).success;
}

/**
 * Validates a PaymentRequirements object (V1 or V2).
 *
 * @param value - The value to validate
 * @returns A result object with success status and data or error
 */
export function parsePaymentRequirements(
  value: unknown,
): z.SafeParseReturnType<unknown, PaymentRequirements> {
  return PaymentRequirementsSchema.safeParse(value);
}

/**
 * Validates a PaymentRequirements object and throws on error.
 *
 * @param value - The value to validate
 * @returns The validated PaymentRequirements
 * @throws ZodError if validation fails
 */
export function validatePaymentRequirements(value: unknown): PaymentRequirements {
  return PaymentRequirementsSchema.parse(value);
}

/**
 * Type guard for PaymentRequirements (V1 or V2).
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentRequirements
 */
export function isPaymentRequirements(value: unknown): value is PaymentRequirements {
  return PaymentRequirementsSchema.safeParse(value).success;
}

/**
 * Validates a PaymentPayload object (V1 or V2).
 *
 * @param value - The value to validate
 * @returns A result object with success status and data or error
 */
export function parsePaymentPayload(
  value: unknown,
): z.SafeParseReturnType<unknown, PaymentPayload> {
  return PaymentPayloadSchema.safeParse(value);
}

/**
 * Validates a PaymentPayload object and throws on error.
 *
 * @param value - The value to validate
 * @returns The validated PaymentPayload
 * @throws ZodError if validation fails
 */
export function validatePaymentPayload(value: unknown): PaymentPayload {
  return PaymentPayloadSchema.parse(value);
}

/**
 * Type guard for PaymentPayload (V1 or V2).
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentPayload
 */
export function isPaymentPayload(value: unknown): value is PaymentPayload {
  return PaymentPayloadSchema.safeParse(value).success;
}

// ============================================================================
// Version-Specific Type Guards
// ============================================================================

/**
 * Type guard for PaymentRequiredV1.
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentRequiredV1
 */
export function isPaymentRequiredV1(value: unknown): value is PaymentRequiredV1 {
  return PaymentRequiredV1Schema.safeParse(value).success;
}

/**
 * Type guard for PaymentRequiredV2.
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentRequiredV2
 */
export function isPaymentRequiredV2(value: unknown): value is PaymentRequiredV2 {
  return PaymentRequiredV2Schema.safeParse(value).success;
}

/**
 * Type guard for PaymentRequirementsV1.
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentRequirementsV1
 */
export function isPaymentRequirementsV1(value: unknown): value is PaymentRequirementsV1 {
  return PaymentRequirementsV1Schema.safeParse(value).success;
}

/**
 * Type guard for PaymentRequirementsV2.
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentRequirementsV2
 */
export function isPaymentRequirementsV2(value: unknown): value is PaymentRequirementsV2 {
  return PaymentRequirementsV2Schema.safeParse(value).success;
}

/**
 * Type guard for PaymentPayloadV1.
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentPayloadV1
 */
export function isPaymentPayloadV1(value: unknown): value is PaymentPayloadV1 {
  return PaymentPayloadV1Schema.safeParse(value).success;
}

/**
 * Type guard for PaymentPayloadV2.
 *
 * @param value - The value to check
 * @returns True if the value is a valid PaymentPayloadV2
 */
export function isPaymentPayloadV2(value: unknown): value is PaymentPayloadV2 {
  return PaymentPayloadV2Schema.safeParse(value).success;
}

// ============================================================================
// Re-export zod for convenience
// ============================================================================

export { z } from "zod";
