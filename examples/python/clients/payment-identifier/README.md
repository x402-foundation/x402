# Payment-Identifier Extension Client Example

Example client demonstrating how to use the `payment-identifier` extension to enable **idempotency** when making payments.

## How It Works

1. Client generates a unique payment ID using `generate_payment_id()`
2. Client includes the payment ID in the `PaymentPayload` using `append_payment_identifier_to_extensions()`
3. Server caches responses keyed by payment ID
4. Retry requests with the same payment ID return cached responses without re-processing payment

```python
from x402 import x402Client
from x402.extensions.payment_identifier import (
    append_payment_identifier_to_extensions,
    generate_payment_id,
)
from x402.http.clients import x402HttpxClient

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

async with x402HttpxClient(client) as http:
    # First request - payment is processed
    response1 = await http.get(url)

    # Retry with same payment ID - cached response returned (no payment)
    response2 = await http.get(url)
```

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

Expected: Server returns cached response without payment processing

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
- **Client crashes**: Resume requests after restart using persisted payment IDs
- **Load balancing**: Same request can hit different servers with shared cache
- **Testing**: Replay requests during development without spending funds

## Best Practices

1. **Generate payment IDs at the logical request level**, not per retry
2. **Persist payment IDs** for long-running operations so they survive restarts
3. **Use descriptive prefixes** (e.g., `order_`, `sub_`) to identify payment types
4. **Don't reuse payment IDs** across different logical requests
