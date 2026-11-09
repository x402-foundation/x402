import { wrapFetchWithPayment } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import {
  createE2EClient,
  runClientScenario,
  type RequestResult,
} from "../../index.ts";

/**
 * Fetch E2E Test Client with x402 Payment Wrapper
 */

const { url, client, batchSettlementScheme, batchSettlementPhase } = await createE2EClient();
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

/**
 * Issues a single paid request and returns the parsed result.
 */
async function issueRequest(): Promise<RequestResult> {
  const response = await fetchWithPayment(url, { method: "GET" });
  const data = await response.json();
  let paymentResponse;
  try {
    paymentResponse = httpClient.getPaymentSettleResponse(name => response.headers.get(name));
  } catch {
    paymentResponse = undefined;
  }

  if (!paymentResponse) {
    if (response.status === 402) {
      const bodyError = (data as { error?: unknown })?.error;
      return {
        success: false,
        data,
        status_code: response.status,
        error: typeof bodyError === "string" && bodyError ? `Payment failed (402): ${bodyError}` : `Payment failed (402): ${JSON.stringify(data)}`,
      };
    }
    if (!response.ok) {
      const bodyError = (data as { error?: unknown })?.error;
      return {
        success: false,
        data,
        status_code: response.status,
        error:
          typeof bodyError === "string" && bodyError
            ? `Request failed (${response.status}): ${bodyError}`
            : `Request failed (${response.status}): ${JSON.stringify(data)}`,
      };
    }
    return { success: true, data, status_code: response.status };
  }

  return {
    success: paymentResponse.success,
    data,
    status_code: response.status,
    payment_response: paymentResponse,
    ...(paymentResponse.success ? {} : { error: `Payment failed: ${paymentResponse.errorReason ?? "settle unsuccessful"}` }),
  };
}

await runClientScenario({
  url,
  batchSettlementPhase,
  batchSettlementScheme,
  issueRequest,
});
