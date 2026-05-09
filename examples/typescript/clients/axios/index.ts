import { config } from "dotenv";
import { x402Client, wrapAxiosWithPayment, x402HTTPClient } from "@x402/axios";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";
import axios from "axios";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string;
const evmRpcUrl = process.env.EVM_RPC_URL;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Example demonstrating how to use @x402/axios to make requests to x402-protected endpoints.
 *
 * Uses the builder pattern to register payment schemes directly.
 *
 * Required environment variables:
 * - EVM_PRIVATE_KEY: The private key of the EVM signer
 * - SVM_PRIVATE_KEY: The private key of the SVM signer
 *
 * Optional environment variables:
 * - EVM_RPC_URL: JSON-RPC endpoint for on-chain reads (enables gas sponsoring extensions)
 */
async function main(): Promise<void> {
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
  const rpcOptions = evmRpcUrl ? { rpcUrl: evmRpcUrl } : undefined;

  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(evmSigner, rpcOptions));
  client.register("eip155:*", new UptoEvmScheme(evmSigner, rpcOptions));
  client.register("solana:*", new ExactSvmScheme(svmSigner));

  const api = wrapAxiosWithPayment(axios.create(), client);

  console.log(`Making request to: ${url}\n`);
  const response = await api.get(url);
  const body = response.data;
  console.log("Response body:", body);

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(
    name => response.headers[name.toLowerCase()],
  );
  console.log("\nPayment response:", paymentResponse);
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
