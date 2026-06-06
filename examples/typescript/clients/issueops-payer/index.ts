import { config } from "dotenv";
import { privateKeyToAccount } from "viem/accounts";
import { x402Client } from "@x402/core/client";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
  encodePaymentSignatureHeader,
} from "@x402/core/http";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import type { PaymentRequirements } from "@x402/core/types";
import { createServer } from "http";

config();

/**
 * IssueOps x402 Payer.
 *
 * Demonstrates a human-gated x402 payment pattern where payments are authorized
 * by a GitHub issue comment, not triggered automatically. The payer signs payments
 * server-side only after a human types the approval command in a GitHub issue.
 *
 * Flow:
 *   1. GitHub webhook delivers issue_comment event to POST /webhook
 *   2. Handler checks the comment body against the approval pattern
 *   3. On match: probes the resource server for x402 requirements (402 response)
 *   4. Signs EIP-3009 with the relayer key and retries with PAYMENT-SIGNATURE header
 *   5. Logs the settlement transaction hash from the PAYMENT-RESPONSE header
 *
 * Required environment variables:
 *   EVM_PRIVATE_KEY     - Relayer private key that signs EIP-3009
 *   RESOURCE_SERVER_URL - Base URL of the x402-protected resource server
 *
 * Optional environment variables:
 *   ENDPOINT_PATH - Path on the resource server (default: /weather)
 *   PORT          - Port for the webhook listener (default: 3000)
 */

const evmPrivateKey = process.env.EVM_PRIVATE_KEY as `0x${string}`;
const baseURL = process.env.RESOURCE_SERVER_URL || "http://localhost:4021";
const endpointPath = process.env.ENDPOINT_PATH || "/weather";
const resourceUrl = `${baseURL}${endpointPath}`;
const PORT = Number(process.env.PORT ?? 3000);

/** Approval pattern: comment must start with "@gitbankbot pay". */
const APPROVAL_PATTERN = /^@gitbankbot\s+pay\b/i;

/**
 * Settlement result from a completed x402 payment.
 */
interface Settlement {
  transaction: string;
  network: string;
  payer: string;
  data: unknown;
}

/**
 * Executes an x402 payment for the configured resource.
 *
 * @param client - Authenticated x402 client instance
 * @returns Settlement details from the resource server
 */
async function executePayment(client: x402Client): Promise<Settlement> {
  // Probe for payment requirements
  const probe = await fetch(resourceUrl);
  if (probe.status !== 402) {
    throw new Error(`Expected 402 from resource server, got ${probe.status}`);
  }

  const paymentRequiredHeader = probe.headers.get("PAYMENT-REQUIRED");
  if (!paymentRequiredHeader) {
    throw new Error("Missing PAYMENT-REQUIRED header");
  }
  const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);

  const requirements: PaymentRequirements[] = Array.isArray(paymentRequired.accepts)
    ? paymentRequired.accepts
    : [paymentRequired.accepts];

  console.log("Payment requirements:");
  requirements.forEach((req, i) => {
    console.log(`  ${i + 1}. ${req.network} / ${req.scheme} - ${req.amount}`);
  });

  // Sign and encode payment
  const paymentPayload = await client.createPaymentPayload(paymentRequired);
  const paymentHeader = encodePaymentSignatureHeader(paymentPayload);

  // Send paid request
  const paid = await fetch(resourceUrl, {
    headers: { "PAYMENT-SIGNATURE": paymentHeader },
  });
  if (paid.status !== 200) {
    throw new Error(`Payment rejected: HTTP ${paid.status}`);
  }

  const data = await paid.json();
  const settlementHeader = paid.headers.get("PAYMENT-RESPONSE");
  if (!settlementHeader) {
    throw new Error("Missing PAYMENT-RESPONSE header");
  }
  const settlement = decodePaymentResponseHeader(settlementHeader);

  return { ...settlement, data };
}

/**
 * Checks whether a GitHub issue comment authorizes an x402 payment.
 *
 * @param body - Raw comment body from the GitHub webhook payload
 * @returns True if the comment matches the approval pattern
 */
function isApproved(body: string): boolean {
  return APPROVAL_PATTERN.test(body.trim());
}

/**
 * Handles an incoming GitHub webhook payload.
 *
 * @param payload - Parsed webhook payload from GitHub
 * @param client  - Authenticated x402 client instance
 */
async function handleWebhook(
  payload: Record<string, unknown>,
  client: x402Client,
): Promise<void> {
  if (payload.action !== "created") return;

  const comment = payload.comment as Record<string, unknown> | undefined;
  const body = typeof comment?.body === "string" ? comment.body : "";

  if (!isApproved(body)) {
    console.log(`Skipped: "${body.trim().slice(0, 60)}"`);
    return;
  }

  console.log(`Approval: "${body.trim()}"`);
  console.log(`Resource: ${resourceUrl}`);

  const result = await executePayment(client);

  console.log("Settled:");
  console.log(`  tx:      ${result.transaction}`);
  console.log(`  network: ${result.network}`);
  console.log(`  payer:   ${result.payer}`);
  console.log("Data:", result.data);
}

/**
 * Starts the webhook listener.
 */
async function main(): Promise<void> {
  if (!evmPrivateKey) {
    console.error("EVM_PRIVATE_KEY is required");
    process.exit(1);
  }

  const signer = privateKeyToAccount(evmPrivateKey);
  const client = new x402Client().register("eip155:*", new ExactEvmScheme(signer));

  const server = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/webhook") {
      res.writeHead(404).end();
      return;
    }

    let raw = "";
    for await (const chunk of req) raw += chunk;

    try {
      const payload = JSON.parse(raw) as Record<string, unknown>;
      await handleWebhook(payload, client);
      res.writeHead(200).end("ok");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error("Error:", message);
      res.writeHead(500).end(message);
    }
  });

  server.listen(PORT, () => {
    console.log(`IssueOps payer listening on :${PORT}`);
    console.log(`POST /webhook  -- forward GitHub issue_comment events here`);
    console.log(`Resource: ${resourceUrl}`);
  });
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
