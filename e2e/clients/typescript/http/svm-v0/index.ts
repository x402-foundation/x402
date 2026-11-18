import { wrapFetchWithPayment } from "@x402/fetch";
import { x402HTTPClient } from "@x402/core/client";
import {
  createE2EClient,
  runClientScenario,
  type RequestResult,
} from "../../index.ts";

/**
 * SVM-only fetch E2E client that builds Solana version-0 transactions.
 *
 * Clients build the highest transaction version the facilitator advertises in
 * `extra.transactionVersions`, so every other client exercises version 1
 * against facilitators that advertise `[0, 1]`. Narrowing to `[0]` keeps the
 * version-0 path covered end to end.
 */

const { url, client, batchSettlementScheme, batchSettlementPhase } = await createE2EClient({
  families: ["svm"],
  svmTransactionVersions: [0],
});
const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

/**
 * Issues a single paid request and returns the parsed result.
 */
async function issueRequest(): Promise<RequestResult> {
  const response = await fetchWithPayment(url, { method: "GET" });
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
