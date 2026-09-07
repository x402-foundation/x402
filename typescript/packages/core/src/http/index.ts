import { SettleResponse } from "../types";
import { PaymentPayload, PaymentRequired } from "../types/payments";
import { Base64EncodedRegex, safeBase64Decode, safeBase64Encode } from "../utils";

// HTTP Methods that typically use query parameters
export type QueryParamMethods = "GET" | "HEAD" | "DELETE";

// HTTP Methods that typically use request body
export type BodyMethods = "POST" | "PUT" | "PATCH";

/**
 * Encodes a payment payload as a base64 header value.
 *
 * @param paymentPayload - The payment payload to encode
 * @returns Base64 encoded string representation of the payment payload
 */
export function encodePaymentSignatureHeader(paymentPayload: PaymentPayload): string {
  return safeBase64Encode(JSON.stringify(paymentPayload));
}

/**
 * Decodes a base64 payment signature header into a payment payload.
 *
 * @param paymentSignatureHeader - The base64 encoded payment signature header
 * @returns The decoded payment payload
 */
export function decodePaymentSignatureHeader(paymentSignatureHeader: string): PaymentPayload {
  if (!Base64EncodedRegex.test(paymentSignatureHeader)) {
    throw new Error("Invalid payment signature header");
  }
  return JSON.parse(safeBase64Decode(paymentSignatureHeader)) as PaymentPayload;
}

/**
 * Encodes a payment required object as a base64 header value.
 *
 * @param paymentRequired - The payment required object to encode
 * @returns Base64 encoded string representation of the payment required object
 */
export function encodePaymentRequiredHeader(paymentRequired: PaymentRequired): string {
  return safeBase64Encode(JSON.stringify(paymentRequired));
}

/**
 * Decodes a base64 payment required header into a payment required object.
 *
 * @param paymentRequiredHeader - The base64 encoded payment required header
 * @returns The decoded payment required object
 */
export function decodePaymentRequiredHeader(paymentRequiredHeader: string): PaymentRequired {
  if (!Base64EncodedRegex.test(paymentRequiredHeader)) {
    throw new Error("Invalid payment required header");
  }
  return JSON.parse(safeBase64Decode(paymentRequiredHeader)) as PaymentRequired;
}

/**
 * Encodes a payment response as a base64 header value.
 *
 * @param paymentResponse - The payment response to encode
 * @returns Base64 encoded string representation of the payment response
 */
export function encodePaymentResponseHeader(paymentResponse: SettleResponse): string {
  // Strip server-internal facilitator sidechannel; never forward to buyers.
  const buyerFacing = { ...paymentResponse };
  delete buyerFacing.extensionResponses;
  return safeBase64Encode(JSON.stringify(buyerFacing));
}

/**
 * Decodes a base64 payment response header into a settle response.
 *
 * @param paymentResponseHeader - The base64 encoded payment response header
 * @returns The decoded settle response
 */
export function decodePaymentResponseHeader(paymentResponseHeader: string): SettleResponse {
  if (!Base64EncodedRegex.test(paymentResponseHeader)) {
    throw new Error("Invalid payment response header");
  }
  return JSON.parse(safeBase64Decode(paymentResponseHeader)) as SettleResponse;
}

export {
  x402HTTPResourceServer,
  HTTPAdapter,
  HTTPRequestContext,
  HTTPTransportContext,
  HTTPResponseInstructions,
  HTTPProcessResult,
  PaywallConfig,
  PaywallProvider,
  PaymentOption,
  RouteConfig,
  RoutesConfig,
  CompiledRoute,
  DynamicPayTo,
  DynamicPrice,
  UnpaidResponseBody,
  HTTPResponseBody,
  SettlementFailedResponseBody,
  ProcessSettleResultResponse,
  ProcessSettleSuccessResponse,
  ProcessSettleFailureResponse,
  RouteValidationError,
  RouteConfigurationError,
  ProtectedRequestHook,
  HTTPResourceServerExtensionHooks,
  ResourceServerTransportExtensionHooks,
  SETTLEMENT_OVERRIDES_HEADER,
  PAYMENT_REQUIRED_CACHE_CONTROL,
  withPrivateCacheControl,
} from "./x402HTTPResourceServer";
export {
  HTTPFacilitatorClient,
  FacilitatorClient,
  FacilitatorConfig,
  ResponseBodyTooLargeError,
  MAX_CONTROL_PLANE_RESPONSE_BYTES,
  readLimitedBody,
} from "./httpFacilitatorClient";
export {
  FacilitatorResponseError,
  FacilitatorTimeoutError,
  FacilitatorCapabilityError,
  getFacilitatorResponseError,
} from "../types";
export { attachBackgroundInitHandler, isFatalStartupInitError } from "./backgroundInit";
export {
  x402HTTPClient,
  PaymentRequiredContext,
  PaymentRequiredHook,
  HTTPClientExtensionHooks,
  HTTPResourceResponse,
  HTTPPaymentStatus,
} from "./x402HTTPClient";
