import { x402Client, x402ClientConfig, x402HTTPClient } from "@x402/core/client";
import { type PaymentRequired } from "@x402/core/types";
import {
  AxiosHeaders,
  type AxiosInstance,
  type AxiosError,
  type InternalAxiosRequestConfig,
} from "axios";

type X402RetryConfig = InternalAxiosRequestConfig & { __is402Retry?: boolean };

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
    headers: AxiosHeaders.from(config.headers),
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
 */
export function wrapAxiosWithPayment(
  axiosInstance: AxiosInstance,
  client: x402Client | x402HTTPClient,
): AxiosInstance {
  const httpClient = client instanceof x402HTTPClient ? client : new x402HTTPClient(client);

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
        const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired);
        if (hookHeaders) {
          const hookConfig = createX402RetryConfig(originalConfig);
          Object.entries(hookHeaders).forEach(([key, value]) => {
            hookConfig.headers.set(key, value);
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
          paidConfig.headers.set(key, value);
        });

        // Add CORS header to expose payment response
        paidConfig.headers.set(
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
            retryConfig.headers.set(key, value);
          });
          retryConfig.headers.set(
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
          return retryResponse;
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
): AxiosInstance {
  const client = x402Client.fromConfig(config);
  return wrapAxiosWithPayment(axiosInstance, client);
}

// Re-export types and utilities for convenience
export { x402Client, x402HTTPClient } from "@x402/core/client";
export type {
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
