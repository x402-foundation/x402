# Payment-Identifier Extension Server Example

Express.js server demonstrating how to use the `payment-identifier` extension for **idempotency** - avoiding duplicate payment processing when clients retry requests with the same payment ID.

## How It Works

1. Server advertises `payment-identifier` extension support in the `PaymentRequired` response
2. Client includes a unique payment ID in their `PaymentPayload`
3. Server caches responses keyed by payment ID (1-hour TTL)
4. If the same payment ID is seen again, the cached response is returned without re-processing payment

```typescript
import {
  paymentMiddlewareFromHTTPServer,
  x402ResourceServer,
  x402HTTPResourceServer,
} from "@x402/express";
import {
  declarePaymentIdentifierExtension,
  extractPaymentIdentifier,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";

// In-memory cache (use Redis in production)
const idempotencyCache = new Map<string, { timestamp: number; response: unknown }>();
const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour

const routes = {
  "GET /weather": {
    accepts: { scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: address },
    extensions: {
      [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(false), // optional
    },
  },
};

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register("eip155:84532", new ExactEvmScheme())
  .onAfterSettle(async ({ paymentPayload }) => {
    const paymentId = extractPaymentIdentifier(paymentPayload);
    if (paymentId) {
      idempotencyCache.set(paymentId, { timestamp: Date.now(), response: { ... } });
    }
  });

const httpServer = new x402HTTPResourceServer(resourceServer, routes)
  .onProtectedRequest(async (context) => {
    // Check if payment ID is in cache
    const paymentPayload = JSON.parse(Buffer.from(context.paymentHeader, "base64").toString());
    const paymentId = extractPaymentIdentifier(paymentPayload);
    if (paymentId) {
      const cached = idempotencyCache.get(paymentId);
      if (cached && Date.now() - cached.timestamp < CACHE_TTL_MS) {
        return { grantAccess: true }; // Skip payment, grant access
      }
    }
  });

app.use(paymentMiddlewareFromHTTPServer(httpServer));
```

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM address for receiving payments (Base Sepolia)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variable:

- `ADDRESS` - Ethereum address to receive payments

2. Install and build all packages from the typescript examples root:

```bash
cd ../../
pnpm install && pnpm build
cd servers/payment-identifier
```

3. Run the server:

```bash
pnpm dev
```

## Testing with the Client

Run the payment-identifier client example to test idempotency:

```bash
cd ../../clients/payment-identifier
# Ensure .env is setup
pnpm dev
```

The client will:
1. Make a request with a unique payment ID
2. Make a second request with the **same** payment ID
3. The second request returns instantly from cache without payment processing

## Idempotency Behavior

| Scenario | Server Response |
|----------|-----------------|
| New payment ID | Process payment normally, cache response |
| Same payment ID (within TTL) | Return cached response, skip payment |
| Same payment ID (after TTL) | Process payment normally, update cache |
| No payment ID | Process payment normally (no caching) |

## Configuration Options

### Required vs Optional

```typescript
// Payment ID is optional (clients can omit it)
declarePaymentIdentifierExtension(false)

// Payment ID is required (clients must provide it)
declarePaymentIdentifierExtension(true)
```

### Cache TTL

Adjust `CACHE_TTL_MS` based on your use case:
- Short TTL (5-15 min): For time-sensitive resources
- Long TTL (1-24 hours): For static or infrequently changing resources

## Production Considerations

1. **Use Redis or similar** instead of in-memory cache for distributed systems
2. **Handle cache failures gracefully** - if cache is unavailable, process payment normally
3. **Consider payload hashing** - for additional safety, hash the full payload and reject if same ID but different payload (409 Conflict)
4. **Monitor cache hit rates** to tune TTL and detect abuse
