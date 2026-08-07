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

export interface HTTPClientExtensionHooks {
  onPaymentRequired?: (
    declaration: unknown,
    context: PaymentRequiredContext,
  ) => Promise<{ headers: Record<string, string> } | void>;
}

type HTTPClientTransportExtension = {
  transportHooks?: {
    http?: HTTPClientExtensionHooks;
  };
};

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
    for (const hook of this.getPaymentRequiredHooks(paymentRequired)) {
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
   * Parses response headers into protocol types, fires payment response hooks (v2 only),
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
    let settleResponse: SettleResponse | undefined;
    try {
      settleResponse = this.getPaymentSettleResponse(getHeader);
    } catch {
      /* no header */
    }

    if (paymentPayload.x402Version === 1) {
      return { recovered: false, settleResponse };
    }

    let paymentRequired: PaymentRequired | undefined;
    if (!settleResponse && status === 402) {
      try {
        paymentRequired = this.getPaymentRequiredResponse(getHeader);
      } catch {
        /* no header */
      }
    }

    const requirements = paymentPayload.accepted;
    if (!requirements) {
      throw new Error("Invalid x402 v2 payment payload: missing `accepted`");
    }

    const ctx: PaymentResponseContext = {
      paymentPayload,
      requirements,
      ...(settleResponse ? { settleResponse } : {}),
      ...(paymentRequired ? { paymentRequired } : {}),
    };

    const result = await this.client.handlePaymentResponse(ctx);
    return { recovered: result?.recovered === true, settleResponse };
  }

  /**
   * Parses HTTP status, headers, and body into an `HTTPResourceResponse`.
   *
   * Decodes the x402 payment header into `header`: the `PAYMENT-RESPONSE`
   * settlement if present, otherwise the `PAYMENT-REQUIRED` declaration on
   * 402 responses (whose `error` field carries the server's failure reason).
   *
   * @param args - Normalized response inputs from any HTTP transport
   * @param args.status - HTTP response status code
   * @param args.getHeader - Callback to read response headers by name
   * @param args.body - Response body payload
   * @returns The parsed status, body, and decoded payment header
   */
  parsePaymentResult(args: {
    status: number;
    getHeader: (name: string) => string | null | undefined;
    body: unknown;
  }): HTTPResourceResponse {
    const { status, getHeader, body } = args;

    let header: SettleResponse | PaymentRequired | undefined;
    try {
      header = this.getPaymentSettleResponse(getHeader);
    } catch {
      if (status === 402) {
        try {
          header = this.getPaymentRequiredResponse(getHeader, body);
        } catch {
          /* no payment header */
        }
      }
    }

    let paymentStatus: HTTPPaymentStatus = "none";
    if (header && !("success" in header)) {
      paymentStatus = "payment_required";
    }
    if (header && "success" in header) {
      paymentStatus = header.success ? "settled" : "settle_failed";
    }

    return { status, paymentStatus, body, header };
  }

  /**
   * Parses a fetch Response into an `HTTPResourceResponse` for app-level convenience.
   *
   * @param response - The fetch Response to process
   * @returns The parsed status, body, and decoded payment header
   */
  async processResponse(response: Response): Promise<HTTPResourceResponse> {
    const getHeader = (name: string) => response.headers.get(name);
    const contentType = response.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json")
      ? await response.json()
      : await response.text();

    return this.parsePaymentResult({ status: response.status, getHeader, body });
  }

  /**
   * Manual HTTP hooks run before extension hooks scoped to the 402 response.
   *
   * @param paymentRequired - The payment required response from the server
   * @returns Hooks in invocation order
   */
  private getPaymentRequiredHooks(paymentRequired: PaymentRequired): PaymentRequiredHook[] {
    const hooks = [...this.paymentRequiredHooks];
    const declaredExtensions = paymentRequired.extensions;
    if (!declaredExtensions) return hooks;

    for (const extension of this.client.getExtensions()) {
      const httpExtension = extension as HTTPClientTransportExtension;
      const hook = httpExtension.transportHooks?.http?.onPaymentRequired;
      if (!hook || !(extension.key in declaredExtensions)) continue;

      hooks.push(context => hook(declaredExtensions[extension.key], context));
    }

    return hooks;
  }
}

/**
 * Parsed result of an HTTP request to an x402 resource.
 */
export type HTTPResourceResponse = {
  /** HTTP status code. */
  status: number;
  /** x402 payment outcome. */
  paymentStatus: HTTPPaymentStatus;
  /** Parsed response body. */
  body: unknown;
  /**
   * Decoded x402 payment header, if present:
   * - SettleResponse  (from PAYMENT-RESPONSE / X-PAYMENT-RESPONSE)
   * - PaymentRequired (from PAYMENT-REQUIRED; its `error` carries the server reason)
   */
  header?: SettleResponse | PaymentRequired;
};

export type HTTPPaymentStatus = "settled" | "settle_failed" | "payment_required" | "none";
