import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/client";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}` | undefined;
const svmPrivateKey = process.env.SVM_PRIVATE_KEY as string | undefined;
const evmRpcUrl = process.env.EVM_RPC_URL;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Example demonstrating how to use @x402/fetch to make requests to x402-protected endpoints.
 *
 * Required environment variables (at least one):
 * - EVM_PRIVATE_KEY: The private key of the EVM signer
 * - SVM_PRIVATE_KEY: The private key of the SVM signer
 *
 * Optional environment variables:
 * - EVM_RPC_URL: JSON-RPC endpoint for onchain reads (enables gas sponsoring extensions)
 * - EXPECTED_AMOUNT_ATOMIC: the most this client will pay for the resource, in the asset's atomic
 *   units ("10000" is $0.01 USDC). The server sets the price; this pins what you agreed to pay.
 * - EXPECTED_PAY_TO, EXPECTED_ASSET: refuse to sign for any other recipient or asset
 */
async function main(): Promise<void> {
  if (!evmPrivateKey && !svmPrivateKey) {
    console.error("Missing required EVM_PRIVATE_KEY or SVM_PRIVATE_KEY environment variable");
    process.exit(1);
  }

  const client = new x402Client();
  client.setSpendControls({
    maxAmountPerPayment: "$1",
  });

  // A spend cap is a ceiling, not a price check: a server that asks ten times the usual price of a
  // cheap resource stays under $1 and gets paid. Pin what you expect for this resource and refuse
  // anything else before the payment is signed.
  const expectedAmount = process.env.EXPECTED_AMOUNT_ATOMIC;
  const expectedPayTo = process.env.EXPECTED_PAY_TO?.toLowerCase();
  const expectedAsset = process.env.EXPECTED_ASSET?.toLowerCase();
  client.onBeforePaymentCreation(async ({ selectedRequirements: r }) => {
    if (expectedAmount && BigInt(r.amount) > BigInt(expectedAmount)) {
      return {
        abort: true,
        reason: `asked ${r.amount} atomic units, expected at most ${expectedAmount}`,
      };
    }
    if (expectedPayTo && r.payTo.toLowerCase() !== expectedPayTo) {
      return { abort: true, reason: `payTo ${r.payTo} is not the expected recipient` };
    }
    if (expectedAsset && r.asset.toLowerCase() !== expectedAsset) {
      return { abort: true, reason: `asset ${r.asset} is not the expected asset` };
    }
  });
  if (evmPrivateKey) {
    const evmSigner = privateKeyToAccount(evmPrivateKey);
    const rpcOptions = evmRpcUrl ? { rpcUrl: evmRpcUrl } : undefined;
    client.register("eip155:*", new ExactEvmScheme(evmSigner, rpcOptions));
    client.register("eip155:*", new UptoEvmScheme(evmSigner, rpcOptions));
    client.register("eip155:*", new AuthCaptureEvmScheme(evmSigner));
  }
  if (svmPrivateKey) {
    const svmSigner = await createKeyPairSignerFromBytes(base58.decode(svmPrivateKey));
    client.register("solana:*", new ExactSvmScheme(svmSigner));
    client.register("solana:*", new UptoSvmScheme(svmSigner));
  }

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  const httpClient = new x402HTTPClient(client);

  console.log(`Making request to: ${url}\n`);
  const requestT0 = performance.now();
  const response = await fetchWithPayment(url, { method: "GET" });
  const result = await httpClient.processResponse(response);
  console.dir(result, { depth: null });
  console.log(`Request completed in ${((performance.now() - requestT0) / 1000).toFixed(3)}s`);
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
