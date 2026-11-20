# Payment-Identifier Extension Server Example

Example server demonstrating how to implement the `payment-identifier` extension for **idempotent** payment processing.

## How It Works

1. Server advertises `payment-identifier` extension support in PaymentRequired responses
2. Server extracts payment ID from incoming PaymentPayload using `extract_payment_identifier()`
3. Before payment middleware, the server looks up the settled cache, then holds an expiring in-flight reservation (fingerprint + timestamp + token + state). TTL is a server-owned 300s, not client `maxTimeoutSeconds`. The pending map is bounded at 1024 entries. Only `GET /weather` is reserved.
4. After settlement, `on_after_settle` consumes only the matching reservation and caches its exact fingerprint
5. Same payment ID and same request+credential fingerprint return the cached response without payment processing
6. Same payment ID with a different method, path, query, body, extra, timeout, or payment credential returns HTTP 409 and does not grant access
7. A second in-flight request never overwrites a live reservation; in-flight and capacity are HTTP 503 retryable
8. `on_before_settle` aborts before the facilitator if the exact token no longer owns the reservation. Pre-settlement rejection releases the matching pending reservation. A thrown, timed-out, or network settlement outcome is indeterminate: mark a tokenized `outcome_unknown` tombstone and do not release. Python `on_settle_failure` retains because it conflates unsuccessful results and thrown errors. Only a definitive pre-settlement failure may release. A settle failure is not immediately safe to retry. This educational example's 1024-entry map is still susceptible to availability pressure from unauthenticated but syntactically valid payloads.

```python
from request_binding import (
    consume_reservation,
    mark_settlement_started,
    mark_outcome_unknown,
    release_if_pending,
    request_fingerprint,
    reservation_token_from_transport,
    reservation_ttl_seconds,
)
from x402.schemas import AbortResult
from x402.extensions.payment_identifier import (
    PAYMENT_IDENTIFIER,
    declare_payment_identifier_extension,
    extract_payment_identifier,
)
from x402.server import x402ResourceServer

server = x402ResourceServer(facilitator)

# Advertise extension support in route config
routes = {
    "GET /weather": RouteConfig(
        accepts=[...],
        extensions={
            PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=False),
        },
    ),
}

def _hook_reservation_token(ctx):
    return reservation_token_from_transport(getattr(ctx, "transport_context", None))

def _hook_fingerprint(ctx):
    return request_fingerprint(
        method="GET", url="/weather", body=b"", payload=ctx.payment_payload
    )

async def before_settle(ctx):
    payment_id = extract_payment_identifier(ctx.payment_payload)
    if not payment_id:
        return None
    started = mark_settlement_started(
        pending_reservations,
        payment_id=payment_id,
        fingerprint=_hook_fingerprint(ctx),
        now=time.time(),
        ttl_seconds=reservation_ttl_seconds(),
        token=_hook_reservation_token(ctx),
    )
    if not started:
        return AbortResult(reason="payment_identifier_reservation_lost")
    return None

# Consume only the exact owned reservation after settlement.
async def after_settle(ctx):
    payment_id = extract_payment_identifier(ctx.payment_payload)
    if not payment_id:
        return
    fingerprint = consume_reservation(
        pending_reservations,
        payment_id=payment_id,
        fingerprint=_hook_fingerprint(ctx),
        now=time.time(),
        ttl_seconds=reservation_ttl_seconds(),
        token=_hook_reservation_token(ctx),
    )
    if fingerprint:
        idempotency_cache[payment_id] = cached_response

async def retain_unknown_on_settle_failure(ctx):
    payment_id = extract_payment_identifier(ctx.payment_payload)
    if not payment_id:
        return
    mark_outcome_unknown(
        pending_reservations,
        payment_id=payment_id,
        fingerprint=_hook_fingerprint(ctx),
        now=time.time(),
        ttl_seconds=reservation_ttl_seconds(),
        token=_hook_reservation_token(ctx),
    )

async def release_pending_reservation(ctx):
    payment_id = extract_payment_identifier(ctx.payment_payload)
    if not payment_id:
        return
    release_if_pending(
        pending_reservations,
        payment_id=payment_id,
        fingerprint=_hook_fingerprint(ctx),
        now=time.time(),
        ttl_seconds=reservation_ttl_seconds(),
        token=_hook_reservation_token(ctx),
    )

server.on_before_settle(before_settle)
server.on_after_settle(after_settle)
server.on_verify_failure(release_pending_reservation)
server.on_settle_failure(retain_unknown_on_settle_failure)
server.on_verified_payment_canceled(release_pending_reservation)
```

Copy the audited helpers from `request_binding.py` rather than inlining `dict.pop`. `try_reserve` / `bind_payment_id` enforce the 1024-entry bound. Missing token is never ownership.

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- Valid EVM address for receiving payments (Base Sepolia)

## Setup

1. Install dependencies:

```bash
uv sync --reinstall-package x402
```

2. Copy `.env-local` to `.env` and add your EVM address:

```bash
cp .env-local .env
```

Required environment variable:

- `EVM_ADDRESS` - Ethereum address to receive payments

3. Run the server:

```bash
uv run python main.py
```

## Expected Output

```
Payment-Identifier Example Server
   Listening at http://localhost:4022

Idempotency Configuration:
   - Cache TTL: 1 hour
   - In-flight reservation TTL: 300s server-owned (not client maxTimeoutSeconds)
   - Pending map bound: 1024 entries, fail closed at capacity
   - Payment ID: optional (required: false)

How it works:
   1. Client sends payment with a unique payment ID
   2. Server caches the response bound to that ID, the HTTP request, and the payment credential
   3. Same ID and same request+credential fingerprint returns the cached response
   4. Same ID with a different method, path, query, body, or credential returns 409
   5. A live in-flight reservation is never overwritten
   6. Reservations are created only for GET /weather
   7. No duplicate payment processing occurs on a cache hit
```

Request-binding unit tests (no wallet, chain, facilitator, or payment):

```bash
python3 -m unittest test_request_binding.py
```

When requests come in:

```
[Idempotency] Checking payment ID: pay_7d5d747be160e280504c099d984bcfe0
[Idempotency] Cache MISS - proceeding with payment
[Idempotency] Caching response for payment ID: pay_7d5d747be160e280504c099d984bcfe0

[Idempotency] Checking payment ID: pay_7d5d747be160e280504c099d984bcfe0
[Idempotency] Cache HIT - returning cached response (age: 2s)
```

## Testing with the Client

Run the [payment-identifier client example](../../clients/payment-identifier) in another terminal:

```bash
cd ../../clients/payment-identifier
uv run python main.py
```

## Extension Configuration

### Optional Payment ID (Default)

```python
extensions={
    PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=False),
}
```

Clients may optionally provide a payment ID. If provided, it enables idempotency.

### Required Payment ID

```python
extensions={
    PAYMENT_IDENTIFIER: declare_payment_identifier_extension(required=True),
}
```

Clients must provide a payment ID. Requests without one will be rejected.

## Production Considerations

1. **Use a distributed cache** (Redis, Memcached) instead of in-memory dict
2. **Configure appropriate TTL** based on your use case
3. **Bind payment IDs to the HTTP request and settled credential** (method, canonical path+query, raw body, accepted terms, `payload.payload`) and return 409 on drift. Do not hash only the payload or only the HTTP request.
4. **Reserve in-flight payment IDs only on protected paid routes** so concurrent requests cannot overwrite the first fingerprint. Require the exact token for consume/release/mark-unknown. Release pending reservations only on definitive pre-settlement rejection. A thrown/timeout/network settle outcome is indeterminate: keep a tombstone for 300s and do not release. Python `on_settle_failure` retains because it cannot distinguish unsuccessful results from thrown errors.
5. **Replay the exact encoded payment header** on retry, and only for the same request URL and selected accepted terms. Bound the in-memory map at 1024 via `try_reserve`. This GET-only single-process educational example is not a production idempotency library. Unauthenticated but syntactically valid payloads can still fill the bounded map.
