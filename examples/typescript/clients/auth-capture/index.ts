import { AuthCaptureEvmScheme } from "@x402/evm/auth-capture/client";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";

config();

const evmPrivateKeyRaw = process.env.EVM_PRIVATE_KEY?.trim();
const baseURL = process.env.RESOURCE_SERVER_URL?.trim() || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH?.trim() || "/weather";
const url = `${baseURL}${endpointPath}`;

if (!evmPrivateKeyRaw) {
  console.error("EVM_PRIVATE_KEY environment variable is required");
  process.exit(1);
}
const evmPrivateKey = evmPrivateKeyRaw as `0x${string}`;

/**
 * Runs a single paid request against an auth-capture-protected endpoint.
 *
 * The scheme signs a payer-agnostic PaymentInfo hash (as the ERC-3009 nonce by
 * default; Permit2 is also supported). The facilitator submits the resulting
 * authorization to the AuthCaptureEscrow contract; funds are locked there until
 * the captureAuthorizer captures, voids, or the authorization expires.
 *
 * @returns Resolves after the request completes and the payment response is logged.
 */
async function main(): Promise<void> {
  const evmAccount = privateKeyToAccount(evmPrivateKey);

  const client = new x402Client();
  client.register("eip155:*", new AuthCaptureEvmScheme(evmAccount));

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`Payer: ${evmAccount.address}`);
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
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
