import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { UptoEvmScheme } from "@x402/evm/upto/client";

/**
 * Spend Controls Example
 *
 * Demonstrates client-side spendControls: the default `$1` USD cap on
 * recognized pegged assets, opt-in `allowedAssets` (atomic per-asset caps or
 * uncapped), and ticker overrides for a default asset.
 *
 * @param evmPrivateKey - The EVM private key for signing
 * @param url - The URL to make the request to
 */
export async function runSpendControlsExample(
  evmPrivateKey: `0x${string}`,
  url: string,
): Promise<void> {
  console.log("🛡️  Creating client with spendControls...\n");

  const evmSigner = privateKeyToAccount(evmPrivateKey);

  const client = x402Client.fromConfig({
    schemes: [
      { network: "eip155:*", client: new ExactEvmScheme(evmSigner) },
      { network: "eip155:*", client: new UptoEvmScheme(evmSigner) },
    ],
    spendControls: {
      maxAmountPerPayment: "$1", // default USD cap on recognized pegged assets
      allowedAssets: [
        // opt-in non-default with atomic cap
        { network: "eip155:*", asset: "0xCustomToken", maxAmountPerPayment: "2000000" },
        // opt-in non-default uncapped
        { network: "eip155:*", asset: "0xOtherToken" },
        // override USD cap for a default asset by ticker (or on-chain id)
        { network: "eip155:*", asset: "USDC", maxAmountPerPayment: "1000000" },
      ],
    },
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`🌐 Making request to: ${url}\n`);
  const response = await fetchWithPayment(url, { method: "GET" });
  const body = await response.json();

  console.log("✅ Request completed with spendControls\n");
  console.log("Response body:", body);

  const paymentResponse = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response.headers.get(name),
  );
  if (paymentResponse) {
    console.log("\n💰 Payment Details:", paymentResponse);
  }
}
