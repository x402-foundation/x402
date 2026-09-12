import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

/**
 * Stand-in for a real recipient screen — replace with a sanctions /
 * address-reputation API that returns allow/block for an address (e.g.
 * `anchor-x402-safe-pay`, or your own). The hook shape is provider-agnostic.
 *
 * @param payTo - The recipient address the payment would be sent to.
 * @returns Whether the payment to this recipient is allowed, and why not if blocked.
 */
async function screenRecipient(payTo: string): Promise<{ allow: boolean; reason?: string }> {
  const DENY = new Set<string>([
    // Illustrative only — populate from your screening provider (OFAC SDN, etc.).
    "0x8589427373d6d84e98730d7795d8f6f8731fda16", // Tornado Cash (OFAC SDN)
  ]);
  return DENY.has(payTo.toLowerCase())
    ? { allow: false, reason: "recipient failed sanctions/reputation screen" }
    : { allow: true };
}

/**
 * Screen Recipient Example
 *
 * Screen the payment recipient before paying. `onBeforePaymentCreation` runs
 * with the selected requirements — including `payTo`, the address you're about
 * to send funds to — and can abort. Checking the recipient here is the canonical
 * real-world use of that abort: an autonomous payer shouldn't send funds to a
 * sanctioned or known-malicious address without a human in the loop.
 *
 * @param evmPrivateKey - The EVM private key for signing
 * @param url - The URL to make the request to
 */
export async function runScreenRecipientExample(
  evmPrivateKey: `0x${string}`,
  url: string,
): Promise<void> {
  console.log("🛡️  Creating client that screens the recipient before paying...\n");

  const client = new x402Client()
    .register("eip155:*", new ExactEvmScheme(privateKeyToAccount(evmPrivateKey)))
    .onBeforePaymentCreation(async context => {
      const { payTo } = context.selectedRequirements;
      const verdict = await screenRecipient(payTo);
      if (!verdict.allow) {
        console.log(`⛔ [BeforePaymentCreation] blocking payment to ${payTo}: ${verdict.reason}`);
        return { abort: true, reason: verdict.reason };
      }
      console.log(`✅ [BeforePaymentCreation] recipient ${payTo} cleared`);
    });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);

  console.log(`🌐 Making request to: ${url}\n`);
  const response = await fetchWithPayment(url, { method: "GET" });
  const body = await response.json();

  console.log("✅ Request completed\n");
  console.log("Response body:", body);
}
