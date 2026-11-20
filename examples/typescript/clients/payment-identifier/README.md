# Payment-Identifier Extension Client Example

Example client demonstrating how to use the `payment-identifier` extension to enable **idempotency** when making payments.

## How It Works

1. Client generates a unique payment ID using `generatePaymentId()`
2. Client includes the payment ID in the `PaymentPayload` using `appendPaymentIdentifierToExtensions()`
3. Server caches responses keyed by payment ID
4. The client captures the first encoded `PAYMENT-SIGNATURE` header and replays it only for one configured exact request URL and selected accepted payment terms. The target URL is immutable helper configuration. It does not infer capture from a shared pending URL, and it does not replay cross-origin, cross-path, across query drift, or against different accepted terms.

```typescript
import { x402Client, wrapFetchWithPayment, x402HTTPClient } from "@x402/fetch";
import {
  appendPaymentIdentifierToExtensions,
  generatePaymentId,
} from "@x402/extensions/payment-identifier";
import { configureExactHeaderReplay } from "./header-replay.js"; // hashes terms, not the header

const client = new x402Client();
// ... register schemes ...

// Generate a unique payment ID for this logical request
const paymentId = generatePaymentId();

// Hook into payment flow to add the payment ID before payload creation
client.onBeforePaymentCreation(async ({ paymentRequired }) => {
  if (paymentRequired.extensions) {
    appendPaymentIdentifierToExtensions(paymentRequired.extensions, paymentId);
  }
});

const httpClient = new x402HTTPClient(client);
// url is immutable configuration. PaymentCreatedContext has no request URL,
// so a shared pendingUrl cannot correlate concurrent 402s. This helper is
// sequential single-URL scope and fails closed if a non-target 402 arrives
// before capture.
configureExactHeaderReplay(client, httpClient, url);

const fetchWithPayment = wrapFetchWithPayment(fetch, httpClient);

// First request - payment is processed and the exact encoded header is captured
const response1 = await fetchWithPayment(url);

// Retry the same URL and selected terms. Do not create a new signature.
// Do not replay against another origin, path, query, or accepted-terms set.
const response2 = await fetchWithPayment(url);
```

`configureExactHeaderReplay` is the helper in `header-replay.ts`. It binds the in-memory header to the configured exact request URL and `acceptedTermsFingerprint` of selected terms (scheme, network, asset, amount, payTo, normalized maxTimeoutSeconds, recursively canonical extra). Do not reuse one helper across origins or paths. The raw header stays in memory only; do not log or persist it.

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- A running payment-identifier server (see [payment-identifier server example](../../servers/payment-identifier))
- Valid EVM private key for making payments (Base Sepolia with USDC)

## Setup

1. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd clients/payment-identifier
```

2. Copy `.env-local` to `.env` and add your private keys:

```bash
cp .env-local .env
```

Required environment variable:

- `PRIVATE_KEY` - Ethereum private key for EVM payments

3. Start the payment-identifier server (in another terminal):

```bash
cd ../../servers/payment-identifier
pnpm dev
```

4. Run the client:

```bash
pnpm dev
```

## Expected Output

```
🔑 Generated Payment ID: pay_7d5d747be160e280504c099d984bcfe0

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 First Request (with payment ID: pay_7d5d747be160e280...)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Making request to: http://localhost:4022/weather

Response (1523ms): { "report": { "weather": "sunny", "temperature": 70, "cached": false } }

💰 Payment settled on eip155:84532

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📤 Second Request (SAME payment ID: pay_7d5d747be160e280...)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Making request to: http://localhost:4022/weather

💡 Expected: replay exact payment header; cached response, no new signature

Response (45ms): { "report": { "weather": "sunny", "temperature": 70, "cached": true } }

✅ No payment processed - response served from cache!

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Summary
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   Payment ID: pay_7d5d747be160e280504c099d984bcfe0
   First request:  1523ms (payment processed)
   Second request: 45ms (cached)
   ⚡ Cached response was 97% faster!
```

## Use Cases

- **Network failures**: Safely retry failed requests without duplicate payments
- **Bounded same-process retries**: Reuse the captured exact header without creating a second payment credential
- **Load balancing**: Same request can hit different servers with shared cache
- **Testing**: Replay requests during development without spending funds

## Best Practices

1. **Generate payment IDs at the logical request level**, not per retry
2. **Keep the payment ID and captured exact header together only in the bounded in-memory retry helper.** This example does not support restart recovery. Persisting a raw payment credential requires a separate encrypted-storage design and threat review; persisting the ID alone creates a fresh credential and conflicts with credential-bound server state.
3. **Use descriptive prefixes** (e.g., `order_`, `sub_`) to identify payment types
4. **Don't reuse payment IDs** across different logical requests
5. **Replay the exact encoded payment header only for the configured exact request URL and selected accepted terms.** Configure one helper per URL. Do not infer capture from a shared pending URL. Do not reuse it cross-origin, cross-path, across query drift, or against a 402 that no longer offers those terms. A non-target 402 before capture fails closed. Do not log or persist the raw header.
