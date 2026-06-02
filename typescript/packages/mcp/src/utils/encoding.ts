import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";
import {
  MCP_PAYMENT_META_KEY,
  MCP_PAYMENT_REQUIRED_CODE,
  MCP_PAYMENT_RESPONSE_META_KEY,
  type MCPPaymentRequiredError,
  type MCPRequestParamsWithMeta,
  type MCPResultWithMeta,
} from "../types";

// ============================================================================
// Type Guards
// ============================================================================

/**
 * Type guard for checking if a value is a non-null object.
 * Exported for use in other modules.
 *
 * @param value - The value to check
 * @returns True if value is a non-null object
 */
export function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * Type guard for PaymentPayload structure.
 * Only performs minimal structural validation - full validation happens in verifyPayment.
 *
 * @param value - The value to check
 * @returns True if value is a PaymentPayload structure
 */
function isPaymentPayloadStructure(value: unknown): value is PaymentPayload {
  if (!isObject(value)) {
    return false;
  }
  // PaymentPayload must have x402Version and payload fields
  return "x402Version" in value && "payload" in value;
}

/**
 * Type guard for SettleResponse structure.
 *
 * @param value - The value to check
 * @returns True if value is a SettleResponse structure
 */
function isSettleResponseStructure(value: unknown): value is SettleResponse {
  if (!isObject(value)) {
    return false;
  }
  return "success" in value;
}

/**
 * Type guard for PaymentRequired structure.
 *
 * @param value - The value to check
 * @returns True if value is a PaymentRequired structure
 */
function isPaymentRequiredStructure(value: unknown): value is PaymentRequired {
  if (!isObject(value)) {
    return false;
  }
  return (
    "x402Version" in value &&
    "accepts" in value &&
    Array.isArray((value as { accepts: unknown }).accepts)
  );
}

// ============================================================================
// Extraction Functions
// ============================================================================

/**
 * Extracts payment payload from MCP request _meta field.
 * Matches HTTP transport's simple validation approach.
 *
 * @param params - MCP request parameters that may contain _meta
 * @returns The payment payload if present and valid, null otherwise
 */
export function extractPaymentFromMeta(
  params: MCPRequestParamsWithMeta | undefined,
): PaymentPayload | null {
  if (!params?._meta) {
    return null;
  }

  const payment = params._meta[MCP_PAYMENT_META_KEY];

  // Simple validation - just check it has expected structure
  // Full validation happens in verifyPayment
  if (!isPaymentPayloadStructure(payment)) {
    return null;
  }

  return payment;
}

/**
 * Attaches payment payload to MCP request params _meta field
 *
 * @param params - Original request params containing name and optional arguments
 * @param params.name - The tool name
 * @param params.arguments - Optional tool arguments
 * @param params._meta - Optional existing metadata to preserve
 * @param paymentPayload - Payment payload to attach
 * @returns New params object with payment in _meta
 */
export function attachPaymentToMeta(
  params: { name: string; arguments?: Record<string, unknown>; _meta?: Record<string, unknown> },
  paymentPayload: PaymentPayload,
): MCPRequestParamsWithMeta {
  return {
    ...params,
    _meta: {
      ...params._meta,
      [MCP_PAYMENT_META_KEY]: paymentPayload,
    },
  };
}

/**
 * Extracts payment response from MCP result _meta field
 *
 * @param result - MCP result that may contain _meta
 * @returns The settlement response if present, null otherwise
 */
export function extractPaymentResponseFromMeta(
  result: MCPResultWithMeta | undefined,
): SettleResponse | null {
  if (!result?._meta) {
    return null;
  }

  const response = result._meta[MCP_PAYMENT_RESPONSE_META_KEY];

  // Validate it has the required structure
  if (!isSettleResponseStructure(response)) {
    return null;
  }

  return response;
}

/**
 * Result content item for MCP responses
 */
interface ResultContentItem {
  [key: string]: unknown;
  type: string;
}

/**
 * Attaches settlement response to MCP result _meta field
 *
 * @param result - Original result object containing content and optional isError flag
 * @param result.content - The tool result content array
 * @param result.isError - Optional flag indicating if the result is an error
 * @param result._meta - Optional existing metadata to preserve
 * @param settleResponse - Settlement response to attach
 * @returns New result object with payment response in _meta
 */
export function attachPaymentResponseToMeta(
  result: { content: ResultContentItem[]; isError?: boolean; _meta?: Record<string, unknown> },
  settleResponse: SettleResponse,
): MCPResultWithMeta {
  return {
    ...result,
    _meta: {
      ...result._meta,
      [MCP_PAYMENT_RESPONSE_META_KEY]: settleResponse,
    },
  };
}

/**
 * Creates an MCP JSON-RPC error for payment required (402)
 *
 * @param paymentRequired - The payment requirements
 * @param message - Optional custom error message
 * @returns JSON-RPC error object
 */
export function createPaymentRequiredError(
  paymentRequired: PaymentRequired,
  message?: string,
): MCPPaymentRequiredError {
  return {
    code: MCP_PAYMENT_REQUIRED_CODE,
    message: message || "Payment required",
    data: paymentRequired,
  };
}

/**
 * Extracts PaymentRequired from an MCP JSON-RPC error
 *
 * @param error - The error object from a JSON-RPC response
 * @returns The PaymentRequired if this is a 402 error, null otherwise
 */
export function extractPaymentRequiredFromError(error: unknown): PaymentRequired | null {
  if (!isObject(error)) {
    return null;
  }

  // Check if this is a 402 payment required error
  if (error.code !== MCP_PAYMENT_REQUIRED_CODE) {
    return null;
  }

  // Extract and validate the data field
  const data = error.data;
  if (!isPaymentRequiredStructure(data)) {
    return null;
  }

  return data;
}

/**
 * Creates a resource URL for an MCP tool
 *
 * @param toolName - The name of the tool
 * @param customUrl - Optional custom URL override
 * @returns The resource URL
 */
export function createToolResourceUrl(toolName: string, customUrl?: string): string {
  if (customUrl) {
    return customUrl;
  }
  return `mcp://tool/${toolName}`;
}
