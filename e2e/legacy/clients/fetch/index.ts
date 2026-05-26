import { config } from "dotenv";
import { Hex } from "viem";
import { createSigner, decodeXPaymentResponse, MultiNetworkSigner, wrapFetchWithPayment } from "x402-fetch";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as Hex;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;
const baseURL = process.env.RESOURCE_SERVER_URL as string;
const endpointPath = process.env.ENDPOINT_PATH as string;
const url = `${baseURL}${endpointPath}`;

if (!baseURL || !evmPrivateKey || !svmPrivateKey || !endpointPath) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const evmSigner = await createSigner("base-sepolia", evmPrivateKey);
const svmSigner = await createSigner("solana-devnet", svmPrivateKey);
const account = { evm: evmSigner, svm: svmSigner } as MultiNetworkSigner;

const fetchWithPayment = wrapFetchWithPayment(fetch, account);

fetchWithPayment(url, {
  method: "GET",
})
  .then(async response => {
    const data = await response.json();
    const paymentResponse = response.headers.get("x-payment-response");

    const result = {
      success: true,
      data: data,
      status_code: response.status,
      payment_response: decodeXPaymentResponse(paymentResponse!)
    };

    // Output structured result as JSON for proxy to parse
    console.log(JSON.stringify(result));
    process.exit(0);
  })
  .catch(error => {
    const errorResult = {
      success: false,
      error: error.message || String(error),
      status_code: error.response?.status
    };

    console.log(JSON.stringify(errorResult));
    process.exit(1);
  });
