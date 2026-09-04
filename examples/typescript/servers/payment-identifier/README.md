# Payment-Identifier Extension Server Example

Express.js server demonstrating how to use the `payment-identifier` extension for **idempotency** - avoiding duplicate payment processing when clients retry requests with the same payment ID.

## How It Works

1. Server advertises `payment-identifier` extension support in the `PaymentRequired` response
2. Client includes a unique payment ID in their `PaymentPayload`
3. Server looks up the settled cache (1-hour TTL), then holds an expiring in-flight reservation (fingerprint + timestamp + token + state). TTL is a server-owned 300s, not client `maxTimeoutSeconds`. The pending map is bounded at 1024 entries. Only `GET /weather` is reserved.
4. After settlement, `onAfterSettle` consumes only the matching reservation and caches its exact fingerprint
5. Same payment ID and same request+credential fingerprint return the cached response without re-processing payment
6. Same payment ID with a different method, path, query, body, extra, timeout, or payment credential returns HTTP 409 and does not grant access
7. A second in-flight request never overwrites a live reservation; in-flight and capacity are HTTP 503 retryable
8. `onBeforeSettle` aborts before the facilitator if the exact token no longer owns the reservation. Pre-settlement rejection releases the matching pending reservation. Thrown settle errors keep a tokenized tombstone until the 300s TTL. A settle failure is not immediately safe to retry.

```typescript
import { paymentMiddlewareFromHTTPServer } from "@x402/express";

// Bind each payment ID to an HTTP request + credential fingerprint (see request-binding.ts).
// Check the settled cache first, then an in-flight reservation, before payment middleware.
// Same fingerprint after settle: return the cached body. Different fingerprint: HTTP 409.
// Same fingerprint while in flight: HTTP 503 retryable. Do not overwrite a live reservation.
// Reserve only GET /weather. This example is GET-only and hashes an empty body; it does not capture POST bodies.
// Educational example: the 1024-entry pending map is still susceptible to availability pressure
// from unauthenticated but syntactically valid payloads. Use tryReserve / bindPaymentId; do not Map#set.

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
| Same payment ID, same request+credential fingerprint (within cache TTL) | Return cached response, skip payment |
| Same payment ID, same fingerprint, live reservation | 503 retryable in-flight, do not settle again |
| Same payment ID, different request or credential fingerprint | Return 409 Conflict, do not grant access, do not overwrite |
| Pending map at 1024 live entries | 503 retryable capacity, do not verify/settle |
| Same payment ID (after cache TTL) | Process payment normally, update cache |
| Pre-settlement reject or verified-payment cancel | Release matching pending tokenized reservation |
| Thrown settle timeout/network/facilitator error | Outcome-unknown tombstone until 300s TTL; not immediately safe to retry |
| Reservation expires (stale work / outcome-unknown expiry) | Drop reservation; ID can proceed again |
| Before-settle with missing/replaced/mismatched/unknown reservation | Abort before facilitator settlement |
| Exact current-token settle callback after its prior phase deadline | Cache only if cleanup has not replaced it |
| Valid payment header on `/health` or an unmatched path | No reservation; paid route is not blocked |
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

`RESERVATION_TTL_MS` is a server-owned 300s stale-work and outcome-unknown expiry bound, distinct from the 1-hour settled cache. Entering settlement and entering outcome-unknown each refresh that server-owned phase clock. An exact current token may finalize after its deadline only when cleanup has not replaced it; a stale token cannot consume a replacement. Client `maxTimeoutSeconds` is fingerprinted, never used as map TTL. Failed verification must release the matching pending reservation. Thrown settle errors keep a tombstone for that 300s window. HTTP 409 is conflict; HTTP 503 is retryable in-flight or capacity. This educational example is GET-only and single-process. The 1024-entry pending map is still susceptible to availability pressure from unauthenticated but syntactically valid payloads.

Request-binding unit tests (no wallet, chain, facilitator, or payment):

```bash
pnpm test
```

## Production Considerations

1. **Use Redis or similar** instead of in-memory cache for distributed systems
2. **Fail closed when idempotency storage is unavailable** - return retryable HTTP 503 and do not verify or settle. Bypassing idempotency requires a separate merchant policy that does not claim duplicate-settlement protection.
3. **Bind payment IDs to the HTTP request and settled credential** - fingerprint method, canonical path+query, raw body, accepted terms, and `payload.payload`. Do not hash only the payment payload, and do not hash only the HTTP request. Return 409 on drift without grantAccess. This GET-only Express example does not install body-parsing middleware and hashes an empty body.
4. **Reserve in-flight payment IDs only on protected paid routes** so concurrent requests cannot overwrite the first fingerprint. Require the exact token for consume/release/mark-unknown. Release pending reservations only on definitive pre-settlement rejection or a returned `result.success === false`. Thrown settle errors keep a tombstone for 300s; do not treat settle failure as immediately safe to retry.
5. **Replay the exact encoded payment header** on retry, and only for the same request URL and selected accepted terms. Bound the in-memory map at 1024 via `tryReserve`. This GET-only single-process educational example is not a production idempotency library. Unauthenticated but syntactically valid payloads can still fill the bounded map.
