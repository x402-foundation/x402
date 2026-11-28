import { x402Client, x402ClientConfig, x402HTTPClient } from "@x402/core/client";
import { MAX_CONTROL_PLANE_RESPONSE_BYTES, readLimitedText } from "@x402/core/http";
import { type PaymentPayload, type PaymentRequired, type SettleResponse } from "@x402/core/types";

/** Grace after the authorization window closes before an `"unsettled"` reconcile result is trusted. */
const RECONCILE_GRACE_MS = 15_000;
/** Bound on held payments per wrapper so sustained failures cannot grow memory without limit. */
const MAX_HELD_PAYMENTS = 1_000;

/**
 * Thrown when a payment for this request was sent, the resource did not deliver,
 * and the client could not establish that the payment never settled. Signing a
 * new payment here could pay twice, so the caller must reconcile out of band
 * before treating the purchase as failed.
 */
export class PaymentOutcomeUnknownError extends Error {
  /**
   * Creates the error for a sent payment whose outcome could not be established.
   *
   * @param paymentPayload - The payment that was sent and may have settled
   * @param response - The last response received for the paid request
   */
  constructor(
    readonly paymentPayload: PaymentPayload,
    readonly response: Response,
  ) {
    super(
      `Payment outcome unknown: HTTP ${response.status} after a payment was sent; not signing again`,
    );
    this.name = "PaymentOutcomeUnknownError";
  }
}

interface HeldPayment {
  paymentPayload: PaymentPayload;
  /** When the authorization can no longer settle: creation plus `accepted.maxTimeoutSeconds`. */
  expiresAt: number;
}

/**
 * Caps a 402 that will be returned to the caller. Paid resource payloads are left
 * untouched. The body is re-materialized so callers can still read it.
 *
 * @param response - Fetch response from the resource server
 * @returns The original response, or a 402 with a bounded body
 */
async function capReturnedPaymentRequired(response: Response): Promise<Response> {
  if (response.status !== 402) {
    return response;
  }

  const body = await readLimitedText(response, MAX_CONTROL_PLANE_RESPONSE_BYTES);
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
}

/**
 * Identity of a purchase: the same request body to the same resource.
 *
 * @param request - A clone of the request; its body is consumed
 * @returns Key for the held-payment map
 */
async function purchaseKey(request: Request): Promise<string> {
  return `${request.method} ${request.url} ${await request.text()}`;
}

/** Facilitator reason codes are snake_case tokens. */
const REASON_CODE = /^[a-z0-9_]+$/;

/**
 * A settle response that rules out settlement under the sent payload: a
 * facilitator reason code, not `settlement_pending`, with nothing broadcast.
 * Everything else leaves the outcome open. That includes a missing settle
 * response, a free-text reason (resource servers copy the thrown error's
 * message into `errorReason` when the facilitator never answered), a broadcast
 * transaction hash, and a nonce-already-used rejection, which means the held
 * payment itself settled.
 *
 * @param settleResponse - Parsed PAYMENT-RESPONSE header, if present
 * @returns Whether the payment definitely did not settle
 */
function isDefiniteSettleFailure(settleResponse?: SettleResponse): boolean {
  if (!settleResponse || settleResponse.success) {
    return false;
  }
  const reason = settleResponse.errorReason ?? "";
  return (
    REASON_CODE.test(reason) &&
    reason !== "settlement_pending" &&
    !reason.includes("nonce_already_used") &&
    !settleResponse.transaction
  );
}

/**
 * Enables the payment of APIs using the x402 payment protocol v2.
 *
 * This function wraps the native fetch API to automatically handle 402 Payment Required responses
 * by creating and sending payment headers. It will:
 * 1. Make the initial request
 * 2. If a 402 response is received, parse the payment requirements
 * 3. Create a payment header using the configured x402HTTPClient
 * 4. Retry the request with the payment header
 *
 * A signed payment is held per purchase (method, URL and body) until the resource
 * delivers. If the paid attempt fails ambiguously (a timeout, a 5xx, or a new 402
 * after the payment was sent), a repeat call for the same purchase re-presents
 * the held payment instead of signing a new one, so a settled-but-lost payment
 * is not paid twice. A fresh payment is signed only after the facilitator
 * reports a definite failure, or after the authorization window has closed and
 * the scheme's `reconcilePaymentPayload` confirms the payment never settled.
 * When neither can be established, the call throws {@link PaymentOutcomeUnknownError}.
 *
 * @param fetch - The fetch function to wrap (typically globalThis.fetch)
 * @param client - Configured x402Client or x402HTTPClient instance for handling payments
 * @returns A wrapped fetch function that handles 402 responses automatically
 *
 * @example
 * ```typescript
 * import { wrapFetchWithPayment, x402Client } from '@x402/fetch';
 * import { ExactEvmScheme } from '@x402/evm';
 * import { ExactSvmScheme } from '@x402/svm';
 *
 * const client = new x402Client()
 *   .register('eip155:8453', new ExactEvmScheme(evmSigner))
 *   .register('solana:mainnet', new ExactSvmScheme(svmSigner))
 *   .register('eip155:1', new ExactEvmScheme(evmSigner), 1); // v1 protocol
 *
 * const fetchWithPay = wrapFetchWithPayment(fetch, client);
 *
 * // Make a request that may require payment
 * const response = await fetchWithPay('https://api.example.com/paid-endpoint');
 * ```
 *
 * @throws {Error} If no schemes are provided
 * @throws {Error} If the request configuration is missing
 * @throws {Error} If a payment has already been attempted for this request
 * @throws {Error} If there's an error creating the payment header
 * @throws {PaymentOutcomeUnknownError} If a payment was sent and its outcome cannot be established
 */
export function wrapFetchWithPayment(
  fetch: typeof globalThis.fetch,
  client: x402Client | x402HTTPClient,
) {
  const httpClient = client instanceof x402HTTPClient ? client : new x402HTTPClient(client);
  const held = new Map<string, HeldPayment>();

  const hold = (key: string, paymentPayload: PaymentPayload): void => {
    const maxTimeoutSeconds = paymentPayload.accepted?.maxTimeoutSeconds;
    if (typeof maxTimeoutSeconds !== "number") {
      return; // v1 payloads carry no window; not held
    }
    if (held.size >= MAX_HELD_PAYMENTS) {
      held.delete(held.keys().next().value as string);
    }
    held.set(key, { paymentPayload, expiresAt: Date.now() + maxTimeoutSeconds * 1000 });
  };

  const sign = async (key: string, paymentRequired: PaymentRequired): Promise<PaymentPayload> => {
    let paymentPayload: PaymentPayload;
    try {
      paymentPayload = await client.createPaymentPayload(paymentRequired);
    } catch (error) {
      throw new Error(
        `Failed to create payment payload: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }
    hold(key, paymentPayload);
    return paymentPayload;
  };

  /**
   * Re-presents a held payment while its outcome may still be open; signs a new
   * one only when the held payment provably never settled.
   *
   * @param key - Purchase key for the held-payment map
   * @param paymentRequired - Requirements from the 402, used if a new payment is signed
   * @returns The payload to send and whether it is a re-presentation
   */
  const resolvePayload = async (
    key: string,
    paymentRequired: PaymentRequired,
  ): Promise<{ paymentPayload: PaymentPayload; represented: boolean }> => {
    const prior = held.get(key);
    if (prior) {
      const now = Date.now();
      if (now < prior.expiresAt) {
        return { paymentPayload: prior.paymentPayload, represented: true };
      }
      const outcome = await client.reconcilePaymentPayload(prior.paymentPayload);
      if (outcome !== "unsettled" || now < prior.expiresAt + RECONCILE_GRACE_MS) {
        return { paymentPayload: prior.paymentPayload, represented: true };
      }
      held.delete(key);
    }
    return { paymentPayload: await sign(key, paymentRequired), represented: false };
  };

  const withPayment = (request: Request, paymentPayload: PaymentPayload): Request => {
    for (const [key, value] of Object.entries(
      httpClient.encodePaymentSignatureHeader(paymentPayload),
    )) {
      request.headers.set(key, value);
    }
    request.headers.set("Access-Control-Expose-Headers", "PAYMENT-RESPONSE,X-PAYMENT-RESPONSE");
    return request;
  };

  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const clonedRequest = request.clone();

    const response = await fetch(request);

    if (response.status !== 402) {
      return response;
    }

    const responseText = await readLimitedText(response, MAX_CONTROL_PLANE_RESPONSE_BYTES);

    // Parse payment requirements from response
    let paymentRequired: PaymentRequired;
    try {
      // Create getHeader function for case-insensitive header lookup
      const getHeader = (name: string) => response.headers.get(name);

      // Try to get from headers first (v2), then from body (v1)
      let body: PaymentRequired | undefined;
      try {
        if (responseText) {
          body = JSON.parse(responseText) as PaymentRequired;
        }
      } catch {
        // Ignore JSON parse errors - might be header-only response
      }

      paymentRequired = httpClient.getPaymentRequiredResponse(getHeader, body);
    } catch (error) {
      throw new Error(
        `Failed to parse payment requirements: ${error instanceof Error ? error.message : "Unknown error"}`,
      );
    }

    // Run payment required hooks
    const requestUrl = response.url || request.url;
    const hookHeaders = await httpClient.handlePaymentRequired(paymentRequired, requestUrl);
    if (hookHeaders) {
      const hookRequest = clonedRequest.clone();
      for (const [key, value] of Object.entries(hookHeaders)) {
        hookRequest.headers.set(key, value);
      }
      const hookResponse = await fetch(hookRequest);
      if (hookResponse.status !== 402) {
        return hookResponse; // Hook succeeded
      }
      await readLimitedText(hookResponse, MAX_CONTROL_PLANE_RESPONSE_BYTES);
      // Hook's retry got 402, fall through to payment
    }

    // Check if this is already a retry to prevent infinite loops
    if (clonedRequest.headers.has("PAYMENT-SIGNATURE") || clonedRequest.headers.has("X-PAYMENT")) {
      throw new Error("Payment already attempted");
    }

    const key = await purchaseKey(clonedRequest.clone());
    const { paymentPayload, represented } = await resolvePayload(key, paymentRequired);

    // Retry the request with payment
    const secondResponse = await fetch(withPayment(clonedRequest.clone(), paymentPayload));

    // Fire payment response hooks and handle recovery
    const result = await httpClient.processPaymentResult(
      paymentPayload,
      name => secondResponse.headers.get(name),
      secondResponse.status,
    );

    if (secondResponse.status < 400) {
      held.delete(key);
      return secondResponse;
    }
    if (isDefiniteSettleFailure(result.settleResponse)) {
      held.delete(key);
    }

    if (result.recovered) {
      if (secondResponse.status === 402) {
        await readLimitedText(secondResponse, MAX_CONTROL_PLANE_RESPONSE_BYTES);
      }
      // Hook fixed state — retry once. Sign fresh only when the sent payment
      // definitely did not settle; otherwise re-present it.
      const retryPayload = held.has(key) ? paymentPayload : await sign(key, paymentRequired);
      const retryResponse = await fetch(withPayment(clonedRequest, retryPayload));
      // Fire hooks on retry response — no further recovery to prevent loops
      const retryResult = await httpClient.processPaymentResult(
        retryPayload,
        name => retryResponse.headers.get(name),
        retryResponse.status,
      );
      if (retryResponse.status < 400 || isDefiniteSettleFailure(retryResult.settleResponse)) {
        held.delete(key);
      }
      return capReturnedPaymentRequired(retryResponse);
    }

    if (represented && held.has(key)) {
      // Re-presented once already and still neither delivered nor proven unsettled.
      throw new PaymentOutcomeUnknownError(paymentPayload, secondResponse);
    }

    return capReturnedPaymentRequired(secondResponse);
  };
}

/**
 * Creates a payment-enabled fetch function from a configuration object.
 *
 * @param fetch - The fetch function to wrap (typically globalThis.fetch)
 * @param config - Configuration options including scheme registrations and selectors
 * @returns A wrapped fetch function that handles 402 responses automatically
 */
export function wrapFetchWithPaymentFromConfig(
  fetch: typeof globalThis.fetch,
  config: x402ClientConfig,
) {
  const client = x402Client.fromConfig(config);
  return wrapFetchWithPayment(fetch, client);
}

// Re-export types and utilities for convenience
export { x402Client, x402HTTPClient } from "@x402/core/client";
export type { HTTPResourceResponse } from "@x402/core/client";
export type {
  PaymentPolicy,
  SchemeRegistration,
  SelectPaymentRequirements,
  x402ClientConfig,
} from "@x402/core/client";
export { decodePaymentResponseHeader, ResponseBodyTooLargeError } from "@x402/core/http";
export type {
  Network,
  PaymentPayload,
  PaymentReconcileResult,
  PaymentRequired,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";
