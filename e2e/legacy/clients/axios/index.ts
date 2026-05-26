import axios from "axios";
import { config } from "dotenv";
import { Hex } from "viem";
import { withPaymentInterceptor, decodeXPaymentResponse, createSigner, MultiNetworkSigner } from "x402-axios";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as Hex;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;
const baseURL = process.env.RESOURCE_SERVER_URL as string; // e.g. https://example.com
const endpointPath = process.env.ENDPOINT_PATH as string; // e.g. /weather

if (!baseURL || !evmPrivateKey || !svmPrivateKey || !endpointPath) {
  console.error("Missing required environment variables");
  process.exit(1);
}

const evmSigner = await createSigner("base-sepolia", evmPrivateKey);
const svmSigner = await createSigner("solana-devnet", svmPrivateKey);
const account = { evm: evmSigner, svm: svmSigner } as MultiNetworkSigner;

const api = withPaymentInterceptor(
  axios.create({
    baseURL,
  }),
  account,
);

api
  .get(endpointPath)
  .then(response => {
    console.log("Response received:", {
      status: response.status,
      headers: response.headers,
      data: response.data
    });

    const result = {
      success: true,
      data: response.data,
      status_code: response.status,
      payment_response: decodeXPaymentResponse(response.headers["x-payment-response"])
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
