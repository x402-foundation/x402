import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  BuilderCodeClientExtension,
  parseBuilderCodeSuffixFromCalldata,
} from "@x402/extensions/builder-code";
import { privateKeyToAccount } from "viem/accounts";
import { createPublicClient, http, type Hex } from "viem";
import { baseSepolia } from "viem/chains";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const evmRpcUrl = process.env.EVM_RPC_URL ?? "https://sepolia.base.org";
const clientBuilderCode = process.env.CLIENT_BUILDER_CODE || "bc_example_client";
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Example client for builder-code attribution on x402-protected endpoints.
 *
 * Required environment variables:
 * - EVM_PRIVATE_KEY: The private key of the EVM signer
 *
 * Optional environment variables:
 * - EVM_RPC_URL: JSON-RPC endpoint for onchain verification (defaults to Base Sepolia)
 * - CLIENT_BUILDER_CODE: Builder code for client attribution (defaults to "bc_example_client")
 * - RESOURCE_SERVER_URL: Resource server base URL
 * - ENDPOINT_PATH: Paid endpoint path
 */
async function main(): Promise<void> {
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  const rpcOptions = { rpcUrl: evmRpcUrl };

  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(evmSigner, rpcOptions));
  client.registerExtension(new BuilderCodeClientExtension(clientBuilderCode));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`Making request to: ${url}\n`);
  const response = await fetchWithPayment(url, { method: "GET" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  console.log("Response body:", body);

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response.headers.get(name),
  );
  console.log("\nPayment response:", JSON.stringify(paymentResponse, null, 2));

  if (!paymentResponse?.success || !paymentResponse.transaction) {
    throw new Error("Settlement did not return a transaction hash");
  }

  const txHash = paymentResponse.transaction as Hex;
  const publicClient = createPublicClient({
    chain: baseSepolia,
    transport: http(evmRpcUrl),
  });
  const tx = await publicClient.getTransaction({ hash: txHash });

  const attribution = parseBuilderCodeSuffixFromCalldata(tx.input);
  if (!attribution) {
    throw new Error(`ERC-8021 builder-code suffix not found in calldata for ${txHash}`);
  }

  console.log("\nBuilder-code attribution verified onchain:", attribution);
  console.log(`Explorer: https://sepolia.basescan.org/tx/${txHash}`);
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
