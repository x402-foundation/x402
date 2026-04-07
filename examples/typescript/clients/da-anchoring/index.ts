// On-chain records show who paid whom how much — but not why.
// Internal logs are self-testimony.
// A DA Decision Declaration anchored before payment provides
// external, append-only proof of authorization scope.

import { config } from "dotenv";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import { privateKeyToAccount } from "viem/accounts";
import DecisionAnchor from "decision-anchor-sdk";

config();

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const daAuthToken = process.env.DA_AUTH_TOKEN as string;
const targetApiUrl = process.env.TARGET_API_URL || "http://localhost:4021/weather";

interface DdCreateResult {
  dd_id: string;
  dac_amount: number;
  anchored_at: string;
  integrity_hash: string;
}

interface DdConfirmResult {
  status: string;
  confirmed_at: string;
}

/**
 * Create a Decision Declaration on DA before payment execution.
 *
 * @param da - authenticated Decision Anchor SDK client
 * @param apiUrl - the x402-protected endpoint being called
 * @param amount - payment amount from the 402 response
 * @returns - the created DD with id, timestamp, and integrity hash
 */
async function anchorBeforePayment(
  da: InstanceType<typeof DecisionAnchor>,
  apiUrl: string,
  amount: string,
): Promise<DdCreateResult> {
  const dd = await da.dd.create({
    requestId: crypto.randomUUID(),
    dd: {
      dd_unit_type: "single",
      dd_declaration_mode: "self_declared",
      decision_type: "external_interaction",
      decision_action_type: "execute",
      origin_context_type: "external",
      selection_state: "SELECTED",
    },
    ee: {
      ee_retention_period: "medium",
      ee_integrity_verification_level: "standard",
      ee_disclosure_format_policy: "summary",
      ee_responsibility_scope: "standard",
      ee_direct_access_period: "30d",
      ee_direct_access_quota: 5,
    },
    context: {
      summary: `x402 payment authorization: ${amount} USDC for ${apiUrl}`,
      api_url: apiUrl,
      payment_amount: amount,
      payment_chain: "base",
    },
  });

  return dd as DdCreateResult;
}

/**
 * Confirm a Decision Declaration on DA after successful payment.
 *
 * @param da - authenticated Decision Anchor SDK client
 * @param ddId - the DD ID returned from anchorBeforePayment
 * @returns - the confirmation result with status and timestamp
 */
async function anchorAfterPayment(
  da: InstanceType<typeof DecisionAnchor>,
  ddId: string,
): Promise<DdConfirmResult> {
  const confirmed = await da.dd.confirm(ddId);
  return confirmed as DdConfirmResult;
}

/**
 * Main function demonstrating x402 payment with DA decision anchoring.
 *
 * Flow:
 * 1. Set up x402 fetch client with EVM payment scheme
 * 2. Create a DA Decision Declaration (pre-payment anchor)
 * 3. Execute x402 payment via wrapped fetch
 * 4. Confirm the DD (post-payment anchor)
 *
 * @returns - resolves when the example completes
 */
async function main(): Promise<void> {
  // Initialize x402 client
  const evmSigner = privateKeyToAccount(evmPrivateKey);
  const x402 = new x402Client();
  x402.register("eip155:*", new ExactEvmScheme(evmSigner));
  const fetchWithPayment = wrapFetchWithPayment(fetch, x402);

  // Initialize DA client with existing auth token
  const da = new DecisionAnchor({
    baseUrl: process.env.DA_BASE_URL || "https://api.decision-anchor.com",
    authToken: daAuthToken,
  });

  console.log("=== x402 Payment with DA Anchoring ===\n");

  // Step 1: Anchor the payment decision BEFORE execution
  console.log("1. Creating Decision Declaration (pre-payment anchor)...");
  const dd = await anchorBeforePayment(da, targetApiUrl, "0.001");
  console.log(`   DD ID: ${dd.dd_id}`);
  console.log(`   Anchored at: ${dd.anchored_at}`);
  console.log(`   Integrity hash: ${dd.integrity_hash}`);

  // Step 2: Execute x402 payment
  console.log("\n2. Executing x402 payment...");
  const response = await fetchWithPayment(targetApiUrl, { method: "GET" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  console.log(`   Status: ${response.status}`);
  console.log("   Response:", body);

  // Step 3: Confirm the DD AFTER successful payment
  console.log("\n3. Confirming Decision Declaration (post-payment anchor)...");
  const confirmed = await anchorAfterPayment(da, dd.dd_id);
  console.log(`   Status: ${confirmed.status}`);
  console.log(`   Confirmed at: ${confirmed.confirmed_at}`);

  console.log("\n=== Done ===");
  console.log("The DD provides external proof that this payment was authorized");
  console.log("at the recorded scope, independent of on-chain records and internal logs.");
}

main().catch(error => {
  console.error(error?.response?.data?.error ?? error);
  process.exit(1);
});
