import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from ".";
import { SettleResponse } from "../types";
import { PaymentPayload, PaymentRequired } from "../types/payments";
import { x402Client, type PaymentResponseContext } from "../client/x402Client";

/**
 * Context provided to onPaymentRequired hooks.
 */
export interface PaymentRequiredContext {
  paymentRequired: PaymentRequired;
}

/**
 * Hook called when a 402 response is received, before payment processing.
 * Return headers to try before payment, or void to proceed directly to payment.
 */
export type PaymentRequiredHook = (
  context: PaymentRequiredContext,
) => Promise<{ headers: Record<string, string> } | void>;

/**
 * HTTP-specific client for handling x402 payment protocol over HTTP.
 *
 * Wraps a x402Client to provide HTTP-specific encoding/decoding functionality
 * for payment headers and responses while maintaining the builder pattern.
 */
export class x402HTTPClient {
  private paymentRequiredHooks: PaymentRequiredHook[] = [];

  /**
   * Creates a new x402HTTPClient instance.
   *
   * @param client - The underlying x402Client for payment logic
   */
  constructor(private readonly client: x402Client) {}

  /**
   * Register a hook to handle 402 responses before payment.
   * Hooks run in order; first to return headers wins.
   *
   * @param hook - The hook function to register
   * @returns This instance for chaining
   */
  onPaymentRequired(hook: PaymentRequiredHook): this {
    this.paymentRequiredHooks.push(hook);
    return this;
  }

  /**
   * Run hooks and return headers if any hook provides them.
   *
   * @param paymentRequired - The payment required response from the server
   * @returns Headers to use for retry, or null to proceed to payment
   */
  async handlePaymentRequired(
    paymentRequired: PaymentRequired,
  ): Promise<Record<string, string> | null> {
    for (const hook of this.paymentRequiredHooks) {
      const result = await hook({ paymentRequired });
      if (result?.headers) {
        return result.headers;
      }
    }
    return null;
  }

  /**
   * Encodes a payment payload into appropriate HTTP headers based on version.
   *
   * @param paymentPayload - The payment payload to encode
   * @returns HTTP headers containing the encoded payment signature
   */
  encodePaymentSignatureHeader(paymentPayload: PaymentPayload): Record<string, string> {
    switch (paymentPayload.x402Version) {
      case 2:
        return {
          "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(paymentPayload),
        };
      case 1:
        return {
          "X-PAYMENT": encodePaymentSignatureHeader(paymentPayload),
        };
      default:
        throw new Error(
          `Unsupported x402 version: ${(paymentPayload as PaymentPayload).x402Version}`,
        );
    }
  }

  /**
   * Extracts payment required information from HTTP response.
   *
   * @param getHeader - Function to retrieve header value by name (case-insensitive)
   * @param body - Optional response body for v1 compatibility
   * @returns The payment required object
   */
  getPaymentRequiredResponse(
    getHeader: (name: string) => string | null | undefined,
    body?: unknown,
  ): PaymentRequired {
    // v2
    const paymentRequired = getHeader("PAYMENT-REQUIRED");
    if (paymentRequired) {
      return decodePaymentRequiredHeader(paymentRequired);
    }

    // v1
    if (
      body &&
      body instanceof Object &&
      "x402Version" in body &&
      (body as PaymentRequired).x402Version === 1
    ) {
      return body as PaymentRequired;
    }

    throw new Error("Invalid payment required response");
  }

  /**
   * Extracts payment settlement response from HTTP headers.
   *
   * @param getHeader - Function to retrieve header value by name (case-insensitive)
   * @returns The settlement response object
   */
  getPaymentSettleResponse(getHeader: (name: string) => string | null | undefined): SettleResponse {
    // v2
    const paymentResponse = getHeader("PAYMENT-RESPONSE");
    if (paymentResponse) {
      return decodePaymentResponseHeader(paymentResponse);
    }

    // v1
    const xPaymentResponse = getHeader("X-PAYMENT-RESPONSE");
    if (xPaymentResponse) {
      return decodePaymentResponseHeader(xPaymentResponse);
    }

    throw new Error("Payment response header not found");
  }

  /**
   * Creates a payment payload for the given payment requirements.
   * Delegates to the underlying x402Client.
   *
   * @param paymentRequired - The payment required response from the server
   * @returns Promise resolving to the payment payload
   */
  async createPaymentPayload(paymentRequired: PaymentRequired): Promise<PaymentPayload> {
    return this.client.createPaymentPayload(paymentRequired);
  }

  /**
   * Parses response headers into protocol types, fires payment response hooks,
   * and returns whether a hook signaled recovery.
   *
   * Called by transport wrappers (fetch, axios) after the paid request completes.
   *
   * @param paymentPayload - The payload that was sent with the request
   * @param getHeader - Function to retrieve a response header by name
   * @param status - The HTTP status code of the response
   * @returns Whether a hook recovered and the parsed settle response (if any)
   */
  async processPaymentResult(
    paymentPayload: PaymentPayload,
    getHeader: (name: string) => string | null | undefined,
    status: number,
  ): Promise<{ recovered: boolean; settleResponse?: SettleResponse }> {
    const requirements = paymentPayload.accepted;

    let settleResponse: SettleResponse | undefined;
    try {
      settleResponse = this.getPaymentSettleResponse(getHeader);
    } catch {
      /* no header */
    }

    let paymentRequired: PaymentRequired | undefined;
    if (!settleResponse && status === 402) {
      try {
        paymentRequired = this.getPaymentRequiredResponse(getHeader);
      } catch {
        /* no header */
      }
    }

    const ctx: PaymentResponseContext = {
      paymentPayload,
      requirements: requirements!,
      ...(settleResponse ? { settleResponse } : {}),
      ...(paymentRequired ? { paymentRequired } : {}),
    };

    const result = await this.client.handlePaymentResponse(ctx);
    return { recovered: result?.recovered === true, settleResponse };
  }

  /**
   * Parses a fetch Response into a discriminated `x402PaymentResult` for app-level convenience.
   *
   * @param response - The fetch Response to process
   * @returns A discriminated union describing the payment outcome
   */
  async processResponse(response: Response): Promise<x402PaymentResult> {
    const getHeader = (name: string) => response.headers.get(name);

    let settleResponse: SettleResponse | undefined;
    try {
      settleResponse = this.getPaymentSettleResponse(getHeader);
    } catch {
      /* no header */
    }

    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    if (settleResponse && settleResponse.success) {
      return { kind: "success", response, body, settleResponse };
    }

    if (settleResponse && !settleResponse.success) {
      return { kind: "settle_failed", response, body, settleResponse };
    }

    if (response.status === 402) {
      try {
        const paymentRequired = this.getPaymentRequiredResponse(getHeader, body);
        return { kind: "payment_required", response, paymentRequired };
      } catch {
        /* no payment-required header */
      }
    }

    if (response.ok) {
      return { kind: "passthrough", response, body };
    }

    return { kind: "error", response, status: response.status, body };
  }
}

/**
 * Discriminated union describing the outcome of a payment-enabled request.
 */
export type x402PaymentResult =
  | { kind: "success"; response: Response; body: unknown; settleResponse: SettleResponse }
  | { kind: "settle_failed"; response: Response; body: unknown; settleResponse: SettleResponse }
  | { kind: "payment_required"; response: Response; paymentRequired: PaymentRequired }
  | { kind: "error"; response: Response; status: number; body: unknown }
  | { kind: "passthrough"; response: Response; body: unknown };
