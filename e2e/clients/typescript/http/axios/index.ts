import axios from "axios";
import { wrapAxiosWithPayment, decodePaymentResponseHeader } from "@x402/axios";
import {
  createE2EClient,
  runClientScenario,
  type RequestResult,
} from "../../index.ts";

/**
 * Axios E2E Test Client with x402 Payment Wrapper
 */

const { url, client, batchSettlementScheme, batchSettlementPhase } = await createE2EClient();
const axiosWithPayment = wrapAxiosWithPayment(axios.create(), client);

/**
 * Issues a single paid request and returns the parsed result.
 */
async function issueRequest(): Promise<RequestResult> {
  const response = await axiosWithPayment.get(url);
  const paymentResponseHeader =
    response.headers["payment-response"] || response.headers["x-payment-response"];

  if (!paymentResponseHeader) {
    return { success: true, data: response.data, status_code: response.status };
  }

  const decodedPaymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
  return {
    success: decodedPaymentResponse.success,
    data: response.data,
    status_code: response.status,
    payment_response: decodedPaymentResponse,
  };
}

try {
  await runClientScenario({
    url,
    batchSettlementPhase,
    batchSettlementScheme,
    issueRequest,
  });
} catch (error: unknown) {
  const err = error as { message?: string; response?: { status?: number } };
  console.error(
    JSON.stringify({
      success: false,
      error: err.message || "Request failed",
      status_code: err.response?.status || 500,
    }),
  );
  process.exit(1);
}
