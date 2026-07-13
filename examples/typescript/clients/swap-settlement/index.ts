import { ExactEvmScheme } from "@x402/evm/exact/client";
import { withSwapSettlement } from "@x402/extensions";
import { wrapFetchWithPayment, x402Client, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

config();

/**
 * Swap-settlement client: pay a USDC-denominated x402 endpoint while holding a different
 * same-chain asset (e.g. WETH). The facilitator swaps the input asset and delivers exact
 * USDC to the merchant in one atomic transaction.
 *
 * `withSwapSettlement` wraps the regular exact scheme: whenever the server's 402
 * advertises the swap-settlement extension, the quote, requirements-hash validation and
 * witness-bound Permit2 signature all happen inside the library. When the server does not
 * offer it, payments fall through to the wrapped scheme unchanged.
 *
 * Required environment variables:
 * - PRIVATE_KEY: payer key. The payer must hold the input asset and have approved the
 *   canonical Permit2 contract for it (one-time on-chain approval).
 *
 * Optional environment variables:
 * - RESOURCE_SERVER_URL (default http://localhost:4021), ENDPOINT_PATH (default /weather)
 * - INPUT_ASSET (default WETH on Base: 0x4200000000000000000000000000000000000006)
 */

const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
if (!privateKey) {
  console.error("PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;
const inputAsset = (process.env.INPUT_ASSET ||
  "0x4200000000000000000000000000000000000006") as `0x${string}`;

/**
 * Pays for the resource, swapping from the configured input asset when offered.
 */
async function main(): Promise<void> {
  const signer = privateKeyToAccount(privateKey);
  console.log(`Payer: ${signer.address}`);
  console.log(`Input asset: ${inputAsset}\n`);

  const client = new x402Client();
  client.register(
    "eip155:*",
    withSwapSettlement(new ExactEvmScheme(signer), signer, { inputAsset }),
  );

  const httpClient = new x402HTTPClient(client);
  const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

  const response = await fetchWithPayment(url, { method: "GET" });
  console.log(`Response:`, JSON.stringify(await response.json(), null, 2));

  const receipt = httpClient.getPaymentSettleResponse(name => response.headers.get(name));
  const swap = (receipt.extensions?.["swap-settlement"] as { info?: Record<string, string> })?.info;
  console.log(`\nSettled on ${receipt.network}: ${receipt.transaction}`);
  if (swap) {
    console.log(`Paid via swap-settlement: ${swap.amountIn} of ${swap.inputAsset}`);
  } else {
    console.log(`Paid directly in the required asset (no swap needed)`);
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
