import { z } from "zod";
import { NetworkSchema } from "../shared";
import { SvmAddressRegex } from "../shared/svm";
import { Base64EncodedRegex } from "../../shared/base64";

// Constants
const EvmMaxAtomicUnits = 18;
const EvmAddressRegex = /^0x[0-9a-fA-F]{40}$/;
const MixedAddressRegex = /^0x[a-fA-F0-9]{40}|[A-Za-z0-9][A-Za-z0-9-]{0,34}[A-Za-z0-9]$/;
const HexEncoded64ByteRegex = /^0x[0-9a-fA-F]{64}$/;
const EvmSignatureRegex = /^0x[0-9a-fA-F]+$/; // Flexible hex signature validation
// Enums
export const schemes = ["exact"] as const;
export const x402Versions = [1] as const;
export const ErrorReasons = [
  "insufficient_funds",
  "invalid_exact_evm_payload_authorization_valid_after",
  "invalid_exact_evm_payload_authorization_valid_before",
  "invalid_exact_evm_payload_authorization_value",
  "invalid_exact_evm_payload_signature",
  "invalid_exact_evm_payload_undeployed_smart_wallet",
  "invalid_exact_evm_payload_recipient_mismatch",
  "invalid_exact_svm_payload_transaction",
  "invalid_exact_svm_payload_transaction_amount_mismatch",
  "invalid_exact_svm_payload_transaction_create_ata_instruction",
  "invalid_exact_svm_payload_transaction_create_ata_instruction_incorrect_payee",
  "invalid_exact_svm_payload_transaction_create_ata_instruction_incorrect_asset",
  "invalid_exact_svm_payload_transaction_instructions",
  "invalid_exact_svm_payload_transaction_instructions_length",
  "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction",
  "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction",
  "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high",
  "invalid_exact_svm_payload_transaction_instruction_not_spl_token_transfer_checked",
  "invalid_exact_svm_payload_transaction_instruction_not_token_2022_transfer_checked",
  "invalid_exact_svm_payload_transaction_fee_payer_included_in_instruction_accounts",
  "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds",
  "invalid_exact_svm_payload_transaction_not_a_transfer_instruction",
  "invalid_exact_svm_payload_transaction_receiver_ata_not_found",
  "invalid_exact_svm_payload_transaction_sender_ata_not_found",
  "invalid_exact_svm_payload_transaction_simulation_failed",
  "invalid_exact_svm_payload_transaction_transfer_to_incorrect_ata",
  "invalid_network",
  "invalid_payload",
  "invalid_payment_requirements",
  "invalid_scheme",
  "invalid_payment",
  "payment_expired",
  "unsupported_scheme",
  "invalid_x402_version",
  "invalid_transaction_state",
  "invalid_x402_version",
  "settle_exact_svm_block_height_exceeded",
  "settle_exact_svm_transaction_confirmation_timed_out",
  "unsupported_scheme",
  "unexpected_settle_error",
  "unexpected_verify_error",
  "duplicate_settlement",
] as const;

// Refiners
const isInteger: (value: string) => boolean = value =>
  Number.isInteger(Number(value)) && Number(value) >= 0;
const hasMaxLength = (maxLength: number) => (value: string) => value.length <= maxLength;

// x402PaymentRequirements
const EvmOrSvmAddress = z.string().regex(EvmAddressRegex).or(z.string().regex(SvmAddressRegex));
const mixedAddressOrSvmAddress = z
  .string()
  .regex(MixedAddressRegex)
  .or(z.string().regex(SvmAddressRegex));
export const PaymentRequirementsSchema = z.object({
  scheme: z.enum(schemes),
  network: NetworkSchema,
  maxAmountRequired: z.string().refine(isInteger),
  resource: z.string().url(),
  description: z.string(),
  mimeType: z.string(),
  outputSchema: z.record(z.any()).optional(),
  payTo: EvmOrSvmAddress,
  maxTimeoutSeconds: z.number().int(),
  asset: mixedAddressOrSvmAddress,
  extra: z.record(z.any()).optional(),
});
export type PaymentRequirements = z.infer<typeof PaymentRequirementsSchema>;

// x402ExactEvmPayload
export const ExactEvmPayloadAuthorizationSchema = z.object({
  from: z.string().regex(EvmAddressRegex),
  to: z.string().regex(EvmAddressRegex),
  value: z.string().refine(isInteger).refine(hasMaxLength(EvmMaxAtomicUnits)),
  validAfter: z.string().refine(isInteger),
  validBefore: z.string().refine(isInteger),
  nonce: z.string().regex(HexEncoded64ByteRegex),
});
export type ExactEvmPayloadAuthorization = z.infer<typeof ExactEvmPayloadAuthorizationSchema>;

export const ExactEvmPayloadSchema = z.object({
  signature: z.string().regex(EvmSignatureRegex),
  authorization: ExactEvmPayloadAuthorizationSchema,
});
export type ExactEvmPayload = z.infer<typeof ExactEvmPayloadSchema>;

// x402ExactSvmPayload
export const ExactSvmPayloadSchema = z.object({
  transaction: z.string().regex(Base64EncodedRegex),
});
export type ExactSvmPayload = z.infer<typeof ExactSvmPayloadSchema>;

// x402PaymentPayload
export const PaymentPayloadSchema = z.object({
  x402Version: z.number().refine(val => x402Versions.includes(val as 1)),
  scheme: z.enum(schemes),
  network: NetworkSchema,
  payload: z.union([ExactEvmPayloadSchema, ExactSvmPayloadSchema]),
});
export type PaymentPayload = z.infer<typeof PaymentPayloadSchema>;
export type UnsignedPaymentPayload = Omit<PaymentPayload, "payload"> & {
  payload: Omit<ExactEvmPayload, "signature"> & { signature: undefined };
};

// x402 Resource Server Response
export const x402ResponseSchema = z.object({
  x402Version: z.number().refine(val => x402Versions.includes(val as 1)),
  error: z.enum(ErrorReasons).optional(),
  accepts: z.array(PaymentRequirementsSchema).optional(),
  payer: z.string().regex(MixedAddressRegex).optional(),
});
export type x402Response = z.infer<typeof x402ResponseSchema>;

// x402RequestStructure
const HTTPVerbsSchema = z.enum(["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS", "HEAD"]);
export type HTTPVerbs = z.infer<typeof HTTPVerbsSchema>;

export const HTTPRequestStructureSchema = z.object({
  type: z.literal("http"),
  method: HTTPVerbsSchema,
  queryParams: z.record(z.string(), z.string()).optional(),
  bodyType: z.enum(["json", "form-data", "multipart-form-data", "text", "binary"]).optional(),
  bodyFields: z.record(z.string(), z.any()).optional(),
  headerFields: z.record(z.string(), z.any()).optional(),
});

// export const MCPRequestStructureSchema = z.object({
//   type: z.literal("mcp"),
//   sessionIsPayed: z.boolean(),
//   payedAction: z.object({
//     kind: z.enum(["prompts", "resources", "tools"]),
//     name: z.string(),
//   }).optional(),
// });

// export const OpenAPIRequestStructureSchema = z.object({
//   type: z.literal("openapi"),
//   openApiUrl: z.string().url(),
//   path: z.string(),
// });

export const RequestStructureSchema = z.discriminatedUnion("type", [
  HTTPRequestStructureSchema,
  // MCPRequestStructureSchema,
  // OpenAPIRequestStructureSchema,
]);

export type HTTPRequestStructure = z.infer<typeof HTTPRequestStructureSchema>;
// export type MCPRequestStructure = z.infer<typeof MCPRequestStructureSchema>;
// export type OpenAPIRequestStructure = z.infer<typeof OpenAPIRequestStructureSchema>;
export type RequestStructure = z.infer<typeof RequestStructureSchema>;

// x402DiscoveryResource
export const DiscoveredResourceSchema = z.object({
  resource: z.string(),
  type: z.enum(["http"]),
  x402Version: z.number().refine(val => x402Versions.includes(val as 1)),
  accepts: z.array(PaymentRequirementsSchema),
  lastUpdated: z.date(),
  metadata: z.record(z.any()).optional(),
});
export type DiscoveredResource = z.infer<typeof DiscoveredResourceSchema>;

// x402SettleRequest
export const SettleRequestSchema = z.object({
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});
export type SettleRequest = z.infer<typeof SettleRequestSchema>;

// x402VerifyRequest
export const VerifyRequestSchema = z.object({
  paymentPayload: PaymentPayloadSchema,
  paymentRequirements: PaymentRequirementsSchema,
});
export type VerifyRequest = z.infer<typeof VerifyRequestSchema>;

// x402VerifyResponse
export const VerifyResponseSchema = z.object({
  isValid: z.boolean(),
  invalidReason: z.enum(ErrorReasons).optional(),
  payer: EvmOrSvmAddress.optional(),
});
export type VerifyResponse = z.infer<typeof VerifyResponseSchema>;

// x402SettleResponse
export const SettleResponseSchema = z.object({
  success: z.boolean(),
  errorReason: z.enum(ErrorReasons).optional(),
  payer: EvmOrSvmAddress.optional(),
  transaction: z.string().regex(MixedAddressRegex),
  network: NetworkSchema,
});
export type SettleResponse = z.infer<typeof SettleResponseSchema>;

// x402DiscoverListRequest
export const ListDiscoveryResourcesRequestSchema = z.object({
  type: z.string().optional(),
  limit: z.number().optional(),
  offset: z.number().optional(),
});
export type ListDiscoveryResourcesRequest = z.infer<typeof ListDiscoveryResourcesRequestSchema>;

// x402ListDiscoveryResourcesResponse
export const ListDiscoveryResourcesResponseSchema = z.object({
  x402Version: z.number().refine(val => x402Versions.includes(val as 1)),
  items: z.array(DiscoveredResourceSchema),
  pagination: z.object({
    limit: z.number(),
    offset: z.number(),
    total: z.number(),
  }),
});
export type ListDiscoveryResourcesResponse = z.infer<typeof ListDiscoveryResourcesResponseSchema>;

// x402SupportedPaymentKind
export const SupportedPaymentKindSchema = z.object({
  x402Version: z.number().refine(val => x402Versions.includes(val as 1)),
  scheme: z.enum(schemes),
  network: NetworkSchema,
  extra: z.record(z.any()).optional(),
});
export type SupportedPaymentKind = z.infer<typeof SupportedPaymentKindSchema>;

// x402SupportedPaymentKindsResponse
export const SupportedPaymentKindsResponseSchema = z.object({
  kinds: z.array(SupportedPaymentKindSchema),
});
export type SupportedPaymentKindsResponse = z.infer<typeof SupportedPaymentKindsResponseSchema>;

/**
 * Error thrown when payment verification fails.
 */
export class VerifyError extends Error {
  readonly invalidReason?: string;
  readonly payer?: string;
  readonly statusCode: number;

  /**
   * Creates a VerifyError from a failed verification response.
   *
   * @param statusCode - HTTP status code from the facilitator
   * @param response - The verify response containing error details
   */
  constructor(statusCode: number, response: VerifyResponse) {
    super(
      response.invalidReason
        ? `Failed to verify payment: ${response.invalidReason}`
        : `Failed to verify payment: ${statusCode}`,
    );
    this.name = "VerifyError";
    this.statusCode = statusCode;
    this.invalidReason = response.invalidReason;
    this.payer = response.payer;
  }
}

/**
 * Error thrown when payment settlement fails.
 */
export class SettleError extends Error {
  readonly errorReason?: string;
  readonly payer?: string;
  readonly transaction: string;
  readonly network: string;
  readonly statusCode: number;

  /**
   * Creates a SettleError from a failed settlement response.
   *
   * @param statusCode - HTTP status code from the facilitator
   * @param response - The settle response containing error details
   */
  constructor(statusCode: number, response: SettleResponse) {
    super(
      response.errorReason
        ? `Failed to settle payment: ${response.errorReason}`
        : `Failed to settle payment: ${statusCode}`,
    );
    this.name = "SettleError";
    this.statusCode = statusCode;
    this.errorReason = response.errorReason;
    this.payer = response.payer;
    this.transaction = response.transaction;
    this.network = response.network;
  }
}
