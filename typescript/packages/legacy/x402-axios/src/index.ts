import { AxiosInstance, AxiosError } from "axios";
import {
  ChainIdToNetwork,
  PaymentRequirements,
  PaymentRequirementsSchema,
  Signer,
  MultiNetworkSigner,
  isMultiNetworkSigner,
  isSvmSignerWallet,
  Network,
  evm,
  X402Config,
} from "x402/types";
import {
  createPaymentHeader,
  PaymentRequirementsSelector,
  selectPaymentRequirements,
} from "x402/client";

/**
 * Enables the payment of APIs using the x402 payment protocol.
 *
 * When a request receives a 402 response:
 * 1. Extracts payment requirements from the response
 * 2. Creates a payment header using the provided wallet client
 * 3. Retries the original request with the payment header
 * 4. Exposes the X-PAYMENT-RESPONSE header in the final response
 *
 * @param axiosClient - The Axios instance to add the interceptor to
 * @param walletClient - A wallet client that can sign transactions and create payment headers
 * @param paymentRequirementsSelector - A function that selects the payment requirements from the response
 * @param config - Optional configuration for X402 operations (e.g., custom RPC URLs)
 * @returns The modified Axios instance with the payment interceptor
 *
 * @example
 * ```typescript
 * const client = withPaymentInterceptor(
 *   axios.create(),
 *   signer
 * );
 *
 * // With custom RPC configuration
 * const client = withPaymentInterceptor(
 *   axios.create(),
 *   signer,
 *   undefined,
 *   { svmConfig: { rpcUrl: "http://localhost:8899" } }
 * );
 *
 * // The client will automatically handle 402 responses
 * const response = await client.get('https://api.example.com/premium-content');
 * ```
 */
export function withPaymentInterceptor(
  axiosClient: AxiosInstance,
  walletClient: Signer | MultiNetworkSigner,
  paymentRequirementsSelector: PaymentRequirementsSelector = selectPaymentRequirements,
  config?: X402Config,
) {
  axiosClient.interceptors.response.use(
    response => response,
    async (error: AxiosError) => {
      if (!error.response || error.response.status !== 402) {
        return Promise.reject(error);
      }

      try {
        const originalConfig = error.config;
        if (!originalConfig || !originalConfig.headers) {
          return Promise.reject(new Error("Missing axios request configuration"));
        }

        if ((originalConfig as { __is402Retry?: boolean }).__is402Retry) {
          return Promise.reject(error);
        }

        const { x402Version, accepts } = error.response.data as {
          x402Version: number;
          accepts: PaymentRequirements[];
        };
        const parsed = accepts.map(x => PaymentRequirementsSchema.parse(x));

        const network = isMultiNetworkSigner(walletClient)
          ? undefined
          : evm.isSignerWallet(walletClient as typeof evm.EvmSigner)
            ? ChainIdToNetwork[(walletClient as typeof evm.EvmSigner).chain?.id]
            : isSvmSignerWallet(walletClient as Signer)
              ? (["solana", "solana-devnet"] as Network[])
              : undefined;

        const selectedPaymentRequirements = paymentRequirementsSelector(parsed, network, "exact");
        const paymentHeader = await createPaymentHeader(
          walletClient,
          x402Version,
          selectedPaymentRequirements,
          config,
        );

        (originalConfig as { __is402Retry?: boolean }).__is402Retry = true;

        originalConfig.headers["X-PAYMENT"] = paymentHeader;
        originalConfig.headers["Access-Control-Expose-Headers"] = "X-PAYMENT-RESPONSE";

        const secondResponse = await axiosClient.request(originalConfig);
        return secondResponse;
      } catch (paymentError) {
        return Promise.reject(paymentError);
      }
    },
  );

  return axiosClient;
}

export { decodeXPaymentResponse } from "x402/shared";
export { createSigner, type Signer, type MultiNetworkSigner, type X402Config } from "x402/types";
export { type PaymentRequirementsSelector } from "x402/client";
export type { Hex } from "viem";
