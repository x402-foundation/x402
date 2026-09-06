import { config } from "dotenv";
import { base58 } from "@scure/base";
import { createKeyPairSignerFromBytes, type Address } from "@solana/kit";
import { wrapFetchWithPayment } from "@x402/fetch";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import { networkCaip2Pattern } from "../../catalog-network.ts";
import { ExactSwigSvmScheme } from "./swigScheme.js";

config();

const baseURL = process.env.RESOURCE_SERVER_URL as string;
const endpointPath = process.env.ENDPOINT_PATH as string;
const url = `${baseURL}${endpointPath}`;

if (!baseURL || !endpointPath || !process.env.CLIENT_SVM_PRIVATE_KEY) {
  console.log(
    JSON.stringify({
      success: false,
      error: "RESOURCE_SERVER_URL, ENDPOINT_PATH, and CLIENT_SVM_PRIVATE_KEY are required",
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
  base58.decode(process.env.CLIENT_SVM_PRIVATE_KEY as string),
);

const client = new x402Client().register(
  networkCaip2Pattern("svm"),
  new ExactSwigSvmScheme(
    authority,
    swigAccountAddress as Address,
    process.env.SVM_RPC_URL,
  ),
);

const fetchWithPayment = wrapFetchWithPayment(fetch, client);
const httpClient = new x402HTTPClient(client);

try {
  const response = await fetchWithPayment(url, { method: "GET" });
  const parsed = await httpClient.processResponse(response);

  if (parsed.paymentStatus === "payment_required") {
    const header = parsed.header;
    const reason =
      header && !("success" in header) && header.error ? header.error : "Payment required";
    console.log(
      JSON.stringify({
        success: false,
        error: reason,
        data: parsed.body,
        status_code: parsed.status,
      }),
    );
    process.exit(1);
  }

  if (parsed.paymentStatus === "none") {
    console.log(
      JSON.stringify({
        success: true,
        data: parsed.body,
        status_code: parsed.status,
      }),
    );
    process.exit(0);
  }

  const paymentResponse = parsed.header && "success" in parsed.header ? parsed.header : undefined;
  console.log(
    JSON.stringify({
      success: parsed.paymentStatus === "settled",
      data: parsed.body,
      status_code: parsed.status,
      payment_response: paymentResponse,
    }),
  );
  process.exit(parsed.paymentStatus === "settled" ? 0 : 1);
} catch (error) {
  console.log(
    JSON.stringify({
      success: false,
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  process.exit(1);
}
