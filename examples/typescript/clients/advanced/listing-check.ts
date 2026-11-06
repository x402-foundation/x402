import { privateKeyToAccount } from "viem/accounts";
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import type { PaymentRequirements } from "@x402/fetch";
import { ExactEvmScheme } from "@x402/evm/exact/client";

/**
 * Listing Check Example
 *
 * A pre-payment check built only on `onBeforePaymentCreation`. Before anything is signed, it
 * compares the requirement the client selected with what you expected to pay (your own
 * catalog or listing): network, pay-to address and price. It aborts only on a concrete
 * mismatch. A missing listing, a network it does not judge, or an error lets the payment
 * proceed. spendControls still apply first: requirements over the cap are filtered out before
 * any hook runs.
 *
 * @param evmPrivateKey - The EVM private key for signing
 * @param url - The URL to make the request to
 */
export async function runListingCheckExample(
  evmPrivateKey: `0x${string}`,
  url: string,
): Promise<void> {
  // What you expect to pay, keyed by resource URL (e.g. loaded from your catalog).
  const listings = new Map<string, Listing>([
    [url, { network: "eip155:84532", payTo: process.env.EXPECTED_PAY_TO, maxAmount: "10000" }],
  ]);

  const client = x402Client
    .fromConfig({
      schemes: [{ network: "eip155:*", client: new ExactEvmScheme(privateKeyToAccount(evmPrivateKey)) }],
      spendControls: { maxAmountPerPayment: "$1" },
    })
    .onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      const listing = listings.get(paymentRequired.resource?.url ?? "");
      const mismatch = listing ? listingMismatch(selectedRequirements, listing) : null;
      if (mismatch) {
        console.log(`🛑 [listing-check] refusing: ${mismatch}`);
        return { abort: true, reason: `listing mismatch: ${mismatch}` };
      }
      console.log(`✅ [listing-check] ${listing ? "matches the listing" : "no listing, proceeding"}`);
    });

  const fetchWithPayment = wrapFetchWithPayment(fetch, client);
  console.log(`🌐 Making request to: ${url}\n`);
  const response = await fetchWithPayment(url, { method: "GET" });
  console.log("Response body:", await response.json());
}

type Listing = { network?: string; payTo?: string; maxAmount?: string };

/**
 * Returns why `req` does not fit `listing`, or null when it fits (or cannot be judged).
 *
 * @param req - The payment requirement the client selected
 * @param listing - What you expected to pay
 * @returns A short reason, or null
 */
export function listingMismatch(req: PaymentRequirements, listing: Listing): string | null {
  try {
    const evm = /^eip155:/.test(req.network);
    if (listing.network && req.network !== listing.network) {
      return `network ${req.network}, expected ${listing.network}`;
    }
    if (!evm) return null; // only EVM addresses are compared here; other networks pass through
    if (listing.payTo && req.payTo.toLowerCase() !== listing.payTo.toLowerCase()) {
      return `payTo ${req.payTo}, expected ${listing.payTo}`;
    }
    if (listing.maxAmount && /^\d+$/.test(req.amount) && BigInt(req.amount) > BigInt(listing.maxAmount)) {
      return `amount ${req.amount}, expected at most ${listing.maxAmount}`;
    }
    return null;
  } catch {
    return null; // unknown means proceed; spendControls still bound the amount
  }
}
