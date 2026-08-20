# Payment-Identifier Extension Server Example

Express.js server demonstrating how to use the `payment-identifier` extension for **idempotency** - avoiding duplicate payment processing when clients retry requests with the same payment ID.

## How It Works

1. Server advertises `payment-identifier` extension support in the `PaymentRequired` response
2. Client includes a unique payment ID in their `PaymentPayload`
3. Server looks up the settled cache (1-hour TTL), then holds an expiring in-flight reservation (fingerprint + timestamp, 30s TTL)
4. After settlement, `onAfterSettle` consumes only that live reservation and caches its exact fingerprint
5. Same payment ID and same fingerprint return the cached response without re-processing payment
6. Same payment ID with a different method, path, query, or body returns HTTP 409 and does not grant access
7. A second in-flight request never overwrites a live reservation

```typescript
import { paymentMiddlewareFromHTTPServer } from "@x402/express";

// Bind each payment ID to an HTTP request fingerprint (see request-binding.ts).
// Check the settled cache first, then an in-flight reservation, before payment middleware.
// Same fingerprint after settle: return the cached body. Different fingerprint: HTTP 409.
// Same fingerprint while in flight: in-flight 409. Do not overwrite a live reservation.
// This example is GET-only and hashes an empty body; it does not capture POST bodies.

app.use(idempotencyMiddleware); // 200 cache hit or 409 conflict, no grantAccess
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
| --- | --- |
| New payment ID | Reserve, process payment, cache on settle |
| Same payment ID, same request fingerprint (within cache TTL) | Return cached response, skip payment |
| Same payment ID, same fingerprint, live reservation | 409 in-flight conflict, do not settle again |
| Same payment ID, different request fingerprint | Return 409 Conflict, do not grant access, do not overwrite |
| Same payment ID (after cache TTL) | Process payment normally, update cache |
| Reservation expired (failed verification) | Drop reservation; ID can proceed again |
| Settle with missing/expired reservation | Do not cache |
| No payment ID | Process payment normally (no caching) |

## Configuration Options

### Required vs Optional

```typescript
// Payment ID is optional (clients can omit it)
declarePaymentIdentifierExtension(false);

// Payment ID is required (clients must provide it)
declarePaymentIdentifierExtension(true);
```

### Cache TTL

Adjust `CACHE_TTL_MS` based on your use case:

- Short TTL (5-15 min): For time-sensitive resources
- Long TTL (1-24 hours): For static or infrequently changing resources

`RESERVATION_TTL_MS` is 30 seconds, distinct from the 1-hour settled cache. It only covers in-flight verify/settle. Failed verification must expire so the reservation map cannot grow without bound.

Request-binding unit tests (no wallet, chain, facilitator, or payment):

```bash
pnpm test
```

## Production Considerations

1. **Use Redis or similar** instead of in-memory cache for distributed systems
2. **Handle cache failures gracefully** - if cache is unavailable, process payment normally
3. **Bind payment IDs to the HTTP request** - fingerprint method, canonical path+query, raw body, and accepted terms. Do not hash only the payment payload. Return 409 on drift without grantAccess. This GET-only Express example does not install body-parsing middleware and hashes an empty body.
4. **Reserve in-flight payment IDs** with a short TTL so concurrent requests cannot overwrite the first fingerprint
5. **Monitor cache hit rates** to tune TTL and detect abuse
