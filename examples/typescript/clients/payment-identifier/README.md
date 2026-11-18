# Payment-Identifier Extension Client Example

Example client demonstrating how to use the `payment-identifier` extension to enable **idempotency** when making payments.

## How It Works

1. Client generates a unique payment ID using `generatePaymentId()`
2. Client includes the payment ID in the `PaymentPayload` using `appendPaymentIdentifierToExtensions()`
3. Server caches responses keyed by payment ID
4. Retry requests with the same payment ID return cached responses without re-processing payment

```typescript
import { x402Client, wrapFetchWithPayment } from "@x402/fetch";
import { appendPaymentIdentifierToExtensions, generatePaymentId } from "@x402/extensions/payment-identifier";

const client = new x402Client();
// ... register schemes ...

// Generate a unique payment ID for this logical request
const paymentId = generatePaymentId();

// Hook into payment flow to add the payment ID before payload creation
client.onBeforePaymentCreation(async ({ paymentRequired }) => {
  if (!paymentRequired.extensions) {
    paymentRequired.extensions = {};
  }
  appendPaymentIdentifierToExtensions(paymentRequired.extensions, paymentId);
});

const fetchWithPayment = wrapFetchWithPayment(fetch, client);

// First request - payment is processed
const response1 = await fetchWithPayment(url);

// Retry with same payment ID - cached response returned (no payment)
const response2 = await fetchWithPayment(url);
```

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

💡 Expected: Server returns cached response without payment processing

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
- **Client crashes**: Resume requests after restart using persisted payment IDs
- **Load balancing**: Same request can hit different servers with shared cache
- **Testing**: Replay requests during development without spending funds

## Best Practices

1. **Generate payment IDs at the logical request level**, not per retry
2. **Persist payment IDs** for long-running operations so they survive restarts
3. **Use descriptive prefixes** (e.g., `order_`, `sub_`) to identify payment types
4. **Don't reuse payment IDs** across different logical requests
