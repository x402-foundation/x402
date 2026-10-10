import { wrapFetchWithPayment } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import {
  bindHttpRequest,
  createE2EClient,
  e2eRequestUrl,
  runClientScenario,
  type RequestResult,
} from "../../index.ts";

/**
 * Fetch E2E Test Client with x402 Payment Wrapper
 */

/** The request this client makes; lnbtc pays only invoices bound to it. */
const request = { method: "GET", url: e2eRequestUrl() };

const { url, client, batchSettlementScheme, batchSettlementPhase } = await createE2EClient({
  lnbtcRequestBinding: bindHttpRequest(request),
});
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

/**
 * Issues a single paid request and returns the parsed result.
 */
async function issueRequest(): Promise<RequestResult> {
  const response = await fetchWithPayment(request.url, { method: request.method });
  const data = await response.json();
  const paymentResponse = httpClient.getPaymentSettleResponse(name => response.headers.get(name));

  if (!paymentResponse) {
    return { success: true, data, status_code: response.status };
  }

  return {
    success: paymentResponse.success,
    data,
    status_code: response.status,
    payment_response: paymentResponse,
  };
}

await runClientScenario({
  url,
  batchSettlementPhase,
  batchSettlementScheme,
  issueRequest,
});
