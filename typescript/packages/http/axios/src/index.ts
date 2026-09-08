import { x402Client, x402ClientConfig, x402HTTPClient } from "@x402/core/client";
import { type PaymentRequired } from "@x402/core/types";
import {
  type AxiosInstance,
  type AxiosError,
  type AxiosResponse,
  type InternalAxiosRequestConfig,
} from "axios";

type X402RetryConfig = InternalAxiosRequestConfig & { __is402Retry?: boolean };
type AxiosHeaderRecord = Record<string, string>;

const PAID_RESPONSE_DETACH_FAILURE = "Paid response cannot be detached for validation";

/**
 * Detached snapshot given to a caller-owned paid-response validator.
 *
 * Mutating this view cannot change the Axios response returned to the caller
 * or attached to PaidResponseValidationError.
 */
export type PaidResponseValidationView = {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: unknown;
};

/**
 * Context passed to a caller-owned paid-response validator.
 */
export type ValidatePaidResponseContext = {
  paymentRequired: PaymentRequired;
  recovered: boolean;
};

/**
 * Optional caller-owned check of a paid application response.
 *
 * The SDK owns hook placement and evidence preservation. The caller owns
 * parsing, schema, byte limits, and which fields are required. This is not a
 * protocol output-schema dialect. The callback receives a detached view, not
 * the live Axios response.
 *
 * @param response - Detached view of the paid response after payment evidence was observed
 * @param context - Detached payment requirements and whether this is the recovery path
 */
export type ValidatePaidResponse = (
  response: PaidResponseValidationView,
  context: ValidatePaidResponseContext,
) => void | Promise<void>;

/**
 * Optional behavior for wrapAxiosWithPayment.
 */
export type WrapAxiosWithPaymentOptions = {
  /**
   * When set, runs after processPaymentResult on the ordinary paid response
   * and the one bounded recovery response, before the body is returned. The
   * callback receives a detached view; the original Axios response and
   * pre-validator PAYMENT-RESPONSE value are preserved. PAYMENT-RESPONSE is
   * optional: a post-payment success is still validated when the header is
   * absent. Absent by default; current behavior is unchanged.
   */
  validatePaidResponse?: ValidatePaidResponse;
};

/**
 * Thrown when a caller-owned paid-response validator rejects a paid body, or
 * when a paid body cannot be detached for validation.
 *
 * Settlement / payment-response evidence is the pre-validator snapshot. The
 * transport does not retry or create another payment after this error.
 */
export class PaidResponseValidationError extends Error {
  readonly paymentRequired: PaymentRequired;
  readonly paymentResponseHeader?: string;
  readonly recovered: boolean;
  readonly response: AxiosResponse;

  /**
   * Creates an evidence-preserving paid-response validation error.
   *
   * @param message - Validation failure message
   * @param response - Original paid Axios response
   * @param paymentRequired - Payment requirements used for the paid attempt
   * @param recovered - Whether this was the bounded recovery response
   * @param paymentResponseHeader - Pre-validator PAYMENT-RESPONSE snapshot
   * @param cause - Original validator or detach exception, if any
   */
  constructor(
    message: string,
    response: AxiosResponse,
    paymentRequired: PaymentRequired,
    recovered: boolean,
    paymentResponseHeader?: string,
    cause?: unknown,
  ) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.name = "PaidResponseValidationError";
    this.response = response;
    this.paymentRequired = paymentRequired;
    this.recovered = recovered;
    this.paymentResponseHeader = paymentResponseHeader;
  }
}

/**
 * Resolves the final absolute URL for an Axios 402 response.
 *
 * @param config - Original Axios request configuration
 * @param response - Axios error response, if present
 * @returns Absolute request URL (prefers final URL after redirects)
 */
function resolveAxiosRequestUrl(
  config: InternalAxiosRequestConfig,
  response?: AxiosError["response"],
): string {
  const responseUrl =
    (response?.request as { responseURL?: string } | undefined)?.responseURL ??
    (response?.request as { res?: { responseUrl?: string } } | undefined)?.res?.responseUrl;

  if (responseUrl) {
    return responseUrl;
  }

  const url = config.url ?? "";
  if (config.baseURL) {
    try {
      return new URL(url, config.baseURL).href;
    } catch {
      return url || config.baseURL;
    }
  }

  return url;
}

/**
 * Clones Axios headers into a plain record so the caller's Axios instance can
 * normalize them for the retry request.
 *
 * @param headers - Headers from the caller's original Axios request config.
 * @returns Serializable headers for Axios to normalize in the caller's instance.
 */
function cloneAxiosHeaders(headers: InternalAxiosRequestConfig["headers"]): AxiosHeaderRecord {
  const source =
    typeof headers.toJSON === "function"
      ? (headers.toJSON() as Record<string, unknown>)
      : (headers as unknown as Record<string, unknown>);

  return Object.entries(source).reduce<AxiosHeaderRecord>((acc, [key, value]) => {
    if (value !== undefined && value !== null && typeof value !== "function") {
      acc[key] = String(value);
    }

    return acc;
  }, {});
}

/**
 * Sets a header on a retry header record.
 *
 * @param headers - Headers object to update.
 * @param key - Header name.
 * @param value - Header value.
 */
function setAxiosHeader(headers: AxiosHeaderRecord, key: string, value: string): void {
  headers[key] = value;
}

/**
 * Reads a string header from an Axios response, case-insensitively.
 *
 * @param headers - Axios response headers
 * @param name - Header name
 * @returns Header value when present as a string
 */
function getAxiosResponseHeader(
  headers: AxiosResponse["headers"],
  name: string,
): string | undefined {
  const value = headers[name] ?? headers[name.toLowerCase()];
  return typeof value === "string" ? value : undefined;
}

/**
 * Reads the settlement / payment-response header from a paid Axios response.
 *
 * @param response - Axios response after a payment attempt
 * @returns PAYMENT-RESPONSE or legacy X-PAYMENT-RESPONSE value when present
 */
function getPaymentResponseHeader(response: AxiosResponse): string | undefined {
  return (
    getAxiosResponseHeader(response.headers, "PAYMENT-RESPONSE") ??
    getAxiosResponseHeader(response.headers, "X-PAYMENT-RESPONSE")
  );
}

/**
 * Returns true when a value looks like a stream that cannot be cloned without
 * consuming it.
 *
 * @param value - Response body candidate
 * @returns Whether the value is stream-like
 */
function isStreamLike(value: unknown): boolean {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const streamCtor = (globalThis as { ReadableStream?: new (...args: never[]) => object })
    .ReadableStream;
  if (typeof streamCtor === "function" && value instanceof streamCtor) {
    return true;
  }

  const record = value as Record<string, unknown>;
  return typeof record.pipe === "function" || typeof record.getReader === "function";
}

/**
 * Structured-clones a value for a detached validation view.
 *
 * Stream-like values are rejected without reading them. Clone failure is
 * fail-closed: callers must not receive a live body or a weakened snapshot.
 *
 * @param value - Value to detach
 * @returns Independent clone of value
 */
function cloneValidationValue<T>(value: T): T {
  if (isStreamLike(value)) {
    throw new Error(PAID_RESPONSE_DETACH_FAILURE);
  }

  if (typeof structuredClone !== "function") {
    throw new Error(PAID_RESPONSE_DETACH_FAILURE);
  }

  try {
    return structuredClone(value);
  } catch (error) {
    throw new Error(PAID_RESPONSE_DETACH_FAILURE, { cause: error });
  }
}

/**
 * Snapshots Axios response headers into a detached string record.
 *
 * @param headers - Axios response headers
 * @returns Plain header snapshot for the validation view
 */
function snapshotHeaderRecord(headers: AxiosResponse["headers"]): Record<string, string> {
  if (!headers) {
    return {};
  }

  const toJSON = (headers as { toJSON?: () => Record<string, unknown> }).toJSON;
  const source =
    typeof toJSON === "function" ? toJSON.call(headers) : (headers as Record<string, unknown>);

  if (source === null || typeof source !== "object") {
    throw new Error(PAID_RESPONSE_DETACH_FAILURE);
  }

  return Object.entries(source).reduce<Record<string, string>>((acc, [key, value]) => {
    if (value !== undefined && value !== null && typeof value !== "function") {
      acc[key] = String(value);
    }

    return acc;
  }, {});
}

/**
 * Builds a detached validation view of a paid Axios response.
 *
 * @param response - Original paid Axios response
 * @returns Detached status, headers, and body for validator code
 */
function createPaidResponseValidationView(response: AxiosResponse): PaidResponseValidationView {
  return {
    status: response.status,
    statusText: response.statusText,
    headers: snapshotHeaderRecord(response.headers),
    data: cloneValidationValue(response.data),
  };
}

/**
 * Runs the optional caller-owned paid-response validator.
 *
 * The validator receives a detached view. Failure never retries payment. The
 * original Axios response and pre-validator payment-response header are
 * retained on PaidResponseValidationError.
 *
 * @param validator - Caller-supplied validator, if any
 * @param response - Original paid Axios response about to be returned
 * @param context - Payment requirements and recovery flag
 */
async function applyValidatePaidResponse(
  validator: ValidatePaidResponse | undefined,
  response: AxiosResponse,
  context: ValidatePaidResponseContext,
): Promise<void> {
  if (!validator) {
    return;
  }

  const paymentResponseHeader = getPaymentResponseHeader(response);
  let view: PaidResponseValidationView;
  let validationContext: ValidatePaidResponseContext;

  try {
    view = createPaidResponseValidationView(response);
    validationContext = {
      paymentRequired: cloneValidationValue(context.paymentRequired),
      recovered: context.recovered,
    };
  } catch (error) {
    throw new PaidResponseValidationError(
      PAID_RESPONSE_DETACH_FAILURE,
      response,
      context.paymentRequired,
      context.recovered,
      paymentResponseHeader,
      error,
    );
  }

  try {
    await validator(view, validationContext);
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : "Paid response validation failed";
    throw new PaidResponseValidationError(
      message,
      response,
      context.paymentRequired,
      context.recovered,
      paymentResponseHeader,
      error,
    );
  }
}

/**
 * Clones an Axios internal request config so a retry can treat HTTP 402 as a successful
 * response status for validation (so the interceptor can handle payment flow).
 *
 * @param config - Original Axios request configuration for the outgoing request.
 * @returns Request config with copied headers and validateStatus that returns true for 402.
 */
function createX402RetryConfig(config: InternalAxiosRequestConfig): X402RetryConfig {
  const originalValidateStatus = config.validateStatus;

  return {
    ...config,
    headers: cloneAxiosHeaders(config.headers) as InternalAxiosRequestConfig["headers"],
    validateStatus: status => {
      if (status === 402) {
        return true;
      }

      return originalValidateStatus
        ? originalValidateStatus(status)
        : status >= 200 && status < 300;
    },
  };
}

/**
 * Wraps an Axios instance with x402 payment handling.
 *
 * This function adds an interceptor to automatically handle 402 Payment Required responses
 * by creating and sending payment headers. It will:
 * 1. Intercept 402 responses
 * 2. Parse the payment requirements
 * 3. Create a payment header using the configured x402HTTPClient
 * 4. Retry the request with the payment header
 *
 * @param axiosInstance - The Axios instance to wrap
 * @param client - Configured x402Client instance for handling payments
 * @param options - Optional caller-owned paid-response validation. The
 *   validator receives a detached view; the original response is returned or
 *   attached to PaidResponseValidationError.
 * @returns The wrapped Axios instance that handles 402 responses automatically
 *
 * @example
 * ```typescript
 * import axios from 'axios';
 * import { wrapAxiosWithPayment, x402Client } from '@x402/axios';
 * import { ExactEvmScheme } from '@x402/evm';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const account = privateKeyToAccount('0x...');
 * const client = new x402Client()
 *   .register('eip155:*', new ExactEvmScheme(account));
 *
 * const api = wrapAxiosWithPayment(axios.create(), client);
 *
 * // Make a request that may require payment
 * const response = await api.get('https://api.example.com/paid-endpoint');
 * ```
 *
 * @throws {Error} If no schemes are provided
 * @throws {Error} If the request configuration is missing
 * @throws {Error} If a payment has already been attempted for this request
 * @throws {Error} If there's an error creating the payment header
 * @throws {PaidResponseValidationError} If the optional paid-response validator rejects
 */
export function wrapAxiosWithPayment(
  axiosInstance: AxiosInstance,
  client: x402Client | x402HTTPClient,
  options?: WrapAxiosWithPaymentOptions,
): AxiosInstance {
  const httpClient = client instanceof x402HTTPClient ? client : new x402HTTPClient(client);
  const validatePaidResponse = options?.validatePaidResponse;

  axiosInstance.interceptors.response.use(
    response => response,
    async (error: AxiosError) => {
      if (!error.response || error.response.status !== 402) {
        return Promise.reject(error);
      }

      const originalConfig = error.config;
      if (!originalConfig || !originalConfig.headers) {
        return Promise.reject(new Error("Missing axios request configuration"));
      }

      // Check if this is already a retry to prevent infinite loops
      if ((originalConfig as X402RetryConfig).__is402Retry) {
        return Promise.reject(error);
      }

      try {
        // Parse payment requirements from response
        let paymentRequired: PaymentRequired;
        try {
          const response = error.response!; // Already validated above

          // Create getHeader function for case-insensitive header lookup
          const getHeader = (name: string) => {
            const value = response.headers[name] ?? response.headers[name.toLowerCase()];
            return typeof value === "string" ? value : undefined;
          };

          // Try to get from headers first (v2), then from body (v1)
          const body = response.data as PaymentRequired | undefined;

          paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);
        } catch (parseError) {
          return Promise.reject(
            new Error(
              `Failed to parse payment requirements: ${parseError instanceof Error ? parseError.message : "Unknown error"}`,
            ),
          );
        }

        // Run payment required hooks
        const requestUrl = resolveAxiosRequestUrl(originalConfig, error.response);
        const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired, requestUrl);
        if (hookHeaders) {
          const hookConfig = createX402RetryConfig(originalConfig);
          Object.entries(hookHeaders).forEach(([key, value]) => {
            setAxiosHeader(hookConfig.headers, key, value);
          });
          const hookResponse = await axiosInstance.request(hookConfig);
          if (hookResponse.status !== 402) {
            return hookResponse; // Hook succeeded
          }
          // Hook's retry got 402, fall through to payment
        }

        // Create payment payload
        let paymentPayload;
        try {
          paymentPayload = await client.createPaymentPayload(paymentRequired);
        } catch (paymentError) {
          return Promise.reject(
            new Error(
              `Failed to create payment payload: ${paymentError instanceof Error ? paymentError.message : "Unknown error"}`,
            ),
          );
        }

        // Encode payment header
        const paymentHeaders = httpClient.encodePaymentSignatureHeader(paymentPayload);

        const paidConfig = createX402RetryConfig(originalConfig);
        paidConfig.__is402Retry = true;

        // Add payment headers to the request
        Object.entries(paymentHeaders).forEach(([key, value]) => {
          setAxiosHeader(paidConfig.headers, key, value);
        });

        // Add CORS header to expose payment response
        setAxiosHeader(
          paidConfig.headers,
          "Access-Control-Expose-Headers",
          "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
        );

        // Retry the request with payment
        const secondResponse = await axiosInstance.request(paidConfig);

        // Fire payment response hooks and handle recovery
        const getResponseHeader = (name: string) => {
          const value = secondResponse.headers[name] ?? secondResponse.headers[name.toLowerCase()];
          return typeof value === "string" ? value : undefined;
        };
        const result = await httpClient.processPaymentResult(
          paymentPayload,
          getResponseHeader,
          secondResponse.status,
        );

        if (result.recovered) {
          // Retry once with a fresh payload after recovery.
          const freshPayload = await client.createPaymentPayload(paymentRequired);
          const retryHeaders = httpClient.encodePaymentSignatureHeader(freshPayload);
          const retryConfig = createX402RetryConfig(originalConfig);
          Object.entries(retryHeaders).forEach(([key, value]) => {
            setAxiosHeader(retryConfig.headers, key, value);
          });
          setAxiosHeader(
            retryConfig.headers,
            "Access-Control-Expose-Headers",
            "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE",
          );
          const retryResponse = await axiosInstance.request(retryConfig);
          // Process the final retry result without another recovery attempt.
          const getRetryHeader = (name: string) => {
            const value = retryResponse.headers[name] ?? retryResponse.headers[name.toLowerCase()];
            return typeof value === "string" ? value : undefined;
          };
          await httpClient.processPaymentResult(freshPayload, getRetryHeader, retryResponse.status);
          if (retryResponse.status !== 402) {
            await applyValidatePaidResponse(validatePaidResponse, retryResponse, {
              paymentRequired,
              recovered: true,
            });
          }
          return retryResponse;
        }

        if (secondResponse.status !== 402) {
          await applyValidatePaidResponse(validatePaidResponse, secondResponse, {
            paymentRequired,
            recovered: false,
          });
        }
        return secondResponse;
      } catch (retryError) {
        return Promise.reject(retryError);
      }
    },
  );

  return axiosInstance;
}

/**
 * Wraps an Axios instance with x402 payment handling using a configuration object.
 *
 * @param axiosInstance - The Axios instance to wrap
 * @param config - Configuration options including scheme registrations and selectors
 * @param options - Same optional validatePaidResponse as wrapAxiosWithPayment
 * @returns The wrapped Axios instance that handles 402 responses automatically
 *
 * @example
 * ```typescript
 * import axios from 'axios';
 * import { wrapAxiosWithPaymentFromConfig } from '@x402/axios';
 * import { ExactEvmScheme } from '@x402/evm';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const account = privateKeyToAccount('0x...');
 *
 * const api = wrapAxiosWithPaymentFromConfig(axios.create(), {
 *   schemes: [
 *     { network: 'eip155:*', client: new ExactEvmScheme(account) }
 *   ]
 * });
 *
 * const response = await api.get('https://api.example.com/paid-endpoint');
 * ```
 */
export function wrapAxiosWithPaymentFromConfig(
  axiosInstance: AxiosInstance,
  config: x402ClientConfig,
  options?: WrapAxiosWithPaymentOptions,
): AxiosInstance {
  const client = x402Client.fromConfig(config);
  return wrapAxiosWithPayment(axiosInstance, client, options);
}

// Re-export types and utilities for convenience
export { x402Client, x402HTTPClient } from "@x402/core/client";
export type {
  HTTPResourceResponse,
  PaymentPolicy,
  SchemeRegistration,
  SelectPaymentRequirements,
  x402ClientConfig,
} from "@x402/core/client";
export { decodePaymentResponseHeader } from "@x402/core/http";
export type {
  Network,
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
