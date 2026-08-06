import { config } from "dotenv";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { ExactSwigSvmScheme } from "./swigScheme.js";

config();

const baseURL = process.env.RESOURCE_SERVER_URL as string;
const endpointPath = process.env.ENDPOINT_PATH as string;
const url = `${baseURL}${endpointPath}`;

if (!baseURL || !endpointPath || !process.env.SVM_PRIVATE_KEY) {
  console.log(
    JSON.stringify({
      success: false,
      error: "RESOURCE_SERVER_URL, ENDPOINT_PATH, and SVM_PRIVATE_KEY are required",
    }),
  );
  process.exit(1);
}

const swigAccountAddress = process.env.SWIG_ACCOUNT_ADDRESS;
if (!swigAccountAddress) {
  console.log(
    JSON.stringify({
      success: false,
      error:
        "SWIG_ACCOUNT_ADDRESS is required (set in e2e/.env or run via e2e harness which runs swig-setup automatically)",
    }),
  );
  process.exit(1);
}

const authority = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY as string),
);

const client = new x402Client().register(
  "solana:*",
  new ExactSwigSvmScheme(
    authority,
    swigAccountAddress as Address,
    process.env.SVM_RPC_URL,
  ),
);

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

fetchWithPayment(url, {
  method: "GET",
})
  .then(async response => {
    const data = await response.json();
    const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(name =>
      response.headers.get(name),
    );

    if (!paymentResponse) {
      console.log(
        JSON.stringify({
          success: true,
          data,
          status_code: response.status,
        }),
      );
      process.exit(0);
      return;
    }

    console.log(
      JSON.stringify({
        success: paymentResponse.success,
        data,
        status_code: response.status,
        payment_response: paymentResponse,
      }),
    );
    process.exit(paymentResponse.success ? 0 : 1);
  })
  .catch(error => {
    console.log(
      JSON.stringify({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
    process.exit(1);
  });
