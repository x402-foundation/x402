# Payment-Identifier Extension Client Example

Example client demonstrating how to use the `payment-identifier` extension to enable **idempotency** when making payments.

## How It Works

1. Client generates a unique payment ID using `generate_payment_id()`
2. Client includes the payment ID in the `PaymentPayload` using `append_payment_identifier_to_extensions()`
3. Server caches responses keyed by payment ID
4. The client captures the first encoded `PAYMENT-SIGNATURE` header and replays it only for one configured exact request URL and selected accepted payment terms. The target URL is immutable helper configuration. It does not infer capture from a shared pending URL, and it does not replay cross-origin, cross-path, or against different accepted terms.

```python
from x402 import x402Client
from x402.extensions.payment_identifier import (
    append_payment_identifier_to_extensions,
    generate_payment_id,
)
from x402.http import x402HTTPClient
from x402.http.clients import x402HttpxClient
from main import configure_exact_header_replay  # hashes terms, not the header

client = x402Client()
# ... register schemes ...

# Generate a unique payment ID for this logical request
payment_id = generate_payment_id()

# Hook into payment flow to add the payment ID before payload creation
async def before_payment_creation(context):
    extensions = context.payment_required.extensions
    if extensions is not None:
        append_payment_identifier_to_extensions(extensions, payment_id)

client.on_before_payment_creation(before_payment_creation)

http_client = x402HTTPClient(client)
# url is immutable configuration. PaymentCreatedContext has no request URL,
# so a shared pending_url cannot correlate concurrent 402s. This helper is
# sequential single-URL scope and fails closed if a non-target 402 arrives
# before capture.
configure_exact_header_replay(client, http_client, url)

async with x402HttpxClient(http_client) as http:
    # First request - payment is processed and the exact encoded header is captured
    response1 = await http.get(url)

    # Retry the same URL and selected terms. Do not create a new signature.
    # Do not replay against another origin, path, or accepted-terms set.
    response2 = await http.get(url)
```

`configure_exact_header_replay` is the helper in `main.py`. It binds the in-memory header to the configured exact request URL and `accepted_terms_fingerprint` of selected terms (scheme, network, asset, amount, payTo, maxTimeoutSeconds, extra). Do not reuse one helper across origins or paths. The raw header stays in memory only; do not log or persist it.

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- A running payment-identifier server (see [payment-identifier server example](../../servers/payment-identifier))
- Valid EVM private key for making payments (Base Sepolia with USDC)

## Setup

1. Install dependencies:

```bash
uv sync
```

2. Copy `.env-local` to `.env` and add your private key:

```bash
cp .env-local .env
```

Required environment variable:

- `EVM_PRIVATE_KEY` - Ethereum private key for EVM payments

3. Start the payment-identifier server (in another terminal):

```bash
cd ../../servers/payment-identifier
uv run python main.py
```

4. Run the client:

```bash
uv run python main.py
```

## Expected Output

```
Generated Payment ID: pay_7d5d747be160e280504c099d984bcfe0

====================================================
First Request (with payment ID: pay_7d5d747be160e280504c099d984bcfe0)
====================================================
Making request to: http://localhost:4022/weather

Response (1523ms): {"report": {"weather": "sunny", "temperature": 70, "cached": false}}

Payment settled on eip155:84532

====================================================
Second Request (SAME payment ID: pay_7d5d747be160e280504c099d984bcfe0)
====================================================
Making request to: http://localhost:4022/weather

Expected: replay exact payment header; cached response, no new signature

Response (45ms): {"report": {"weather": "sunny", "temperature": 70, "cached": true}}

No payment processed - response served from cache!

====================================================
Summary
====================================================
   Payment ID: pay_7d5d747be160e280504c099d984bcfe0
   First request:  1523ms (payment processed)
   Second request: 45ms (cached)
   Cached response was 97% faster!
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
5. **Replay the exact encoded payment header only for the configured exact request URL and selected accepted terms.** Configure one helper per URL. Do not infer capture from a shared pending URL. Do not reuse it cross-origin, cross-path, or against a 402 that no longer offers those terms. A non-target 402 before capture fails closed. Do not log or persist the raw header.
