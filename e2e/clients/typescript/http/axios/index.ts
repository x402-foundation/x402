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
    if (response.status === 402) {
      const bodyError = (response.data as { error?: unknown })?.error;
      return {
        success: false,
        data: response.data,
        status_code: response.status,
        error: typeof bodyError === "string" && bodyError ? `Payment failed (402): ${bodyError}` : `Payment failed (402): ${JSON.stringify(response.data)}`,
      };
    }
    if (response.status >= 400) {
      const bodyError = (response.data as { error?: unknown })?.error;
      return {
        success: false,
        data: response.data,
        status_code: response.status,
        error:
          typeof bodyError === "string" && bodyError
            ? `Request failed (${response.status}): ${bodyError}`
            : `Request failed (${response.status}): ${JSON.stringify(response.data)}`,
      };
    }
    return { success: true, data: response.data, status_code: response.status };
  }

  const decodedPaymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
  return {
    success: decodedPaymentResponse.success,
    data: response.data,
    status_code: response.status,
    payment_response: decodedPaymentResponse,
    ...(decodedPaymentResponse.success ? {} : { error: `Payment failed: ${decodedPaymentResponse.errorReason ?? "settle unsuccessful"}` }),
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
