import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import {
  appendPaymentIdentifierToExtensions,
  generatePaymentId,
} from "@x402/extensions/payment-identifier";

config();

const privateKey = process.env.PRIVATE_KEY as `0x${string}`;
if (!privateKey) {
  console.error("❌ PRIVATE_KEY environment variable is required");
  process.exit(1);
}

const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4022";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const url = `${baseURL}${endpointPath}`;

/**
 * Example demonstrating how to use the payment-identifier extension for idempotency.
 *
 * This example:
 * 1. Makes a request with a unique payment ID
 * 2. Makes a second request with the SAME payment ID
 * 3. The second request returns from cache without payment processing
 *
 * Required environment variables:
 * - PRIVATE_KEY: The private key of the EVM signer
 */
async function main(): Promise<void> {
  const signer = privateKeyToAccount(privateKey);

  const client = new x402Client();
  client.register("eip155:*", new ExactEvmScheme(signer));

  // Generate a unique payment ID for this request
  const paymentId = generatePaymentId();
  console.log(`\n🔑 Generated Payment ID: ${paymentId}`);

  // Hook into the payment flow to add payment identifier BEFORE payload creation
  // We modify paymentRequired.extensions to include our payment ID
  client.onBeforePaymentCreation(async ({ paymentRequired }) => {
    // Initialize extensions if not present
    if (paymentRequired.extensions) {
      // Append our payment ID to the extensions (only if server declared the extension)
      appendPaymentIdentifierToExtensions(paymentRequired.extensions, paymentId);
    }
  });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  // First request - will process payment
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📤 First Request (with payment ID: ${paymentId})`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Making request to: ${url}\n`);

  const startTime1 = Date.now();
  const response1 = await fetchWithPayment(url, { method: "GET" });
  const duration1 = Date.now() - startTime1;
  const body1 = await response1.json();

  console.log(`Response (${duration1}ms):`, JSON.stringify(body1, null, 2));

  const paymentResponse1 = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response1.headers.get(name),
  );
  if (paymentResponse1) {
    console.log(`\n💰 Payment settled on ${paymentResponse1.network}`);
  }

  // Second request - same payment ID, should return from cache
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📤 Second Request (SAME payment ID: ${paymentId})`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`Making request to: ${url}\n`);
  console.log(`💡 Expected: Server returns cached response without payment processing\n`);

  const startTime2 = Date.now();
  const response2 = await fetchWithPayment(url, { method: "GET" });
  const duration2 = Date.now() - startTime2;
  const body2 = await response2.json();

  console.log(`Response (${duration2}ms):`, JSON.stringify(body2, null, 2));

  const paymentResponse2 = new x402HTTPClient(client).getPaymentSettleResponse(name =>
    response2.headers.get(name),
  );
  if (paymentResponse2) {
    console.log(`\n💰 Payment settled (unexpected - should have been cached)`);
  } else {
    console.log(`\n✅ No payment processed - response served from cache!`);
  }

  // Summary
  console.log(`\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`📊 Summary`);
  console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
  console.log(`   Payment ID: ${paymentId}`);
  console.log(`   First request:  ${duration1}ms (payment processed)`);
  console.log(`   Second request: ${duration2}ms (cached)`);
  if (duration2 < duration1) {
    console.log(
      `   ⚡ Cached response was ${Math.round((1 - duration2 / duration1) * 100)}% faster!`,
    );
  }
  console.log(``);
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
