# Custom x402 Client Example

This example demonstrates how to implement x402 payment handling manually using only the core packages, without the convenience wrappers like `x402HttpxClient` or `x402_requests`.

Use this approach when you need:
- Complete control over every step of the payment flow
- Integration with non-standard HTTP libraries
- Custom retry logic or payment selection strategies

## x402 v2 Protocol Headers

| Header | Direction | Purpose |
|--------|-----------|---------|
| `PAYMENT-REQUIRED` | Server → Client | Payment requirements (in 402 response) |
| `PAYMENT-SIGNATURE` | Client → Server | Signed payment payload (retry request) |
| `PAYMENT-RESPONSE` | Server → Client | Settlement confirmation (success response) |

## Payment Flow

```
┌────────────────────────────────────────────────────────────────────┐
│                     Custom x402 Payment Flow                       │
└────────────────────────────────────────────────────────────────────┘

    Client                                              Server
      │                                                   │
      │  1. GET /resource                                 │
      │ ─────────────────────────────────────────────────>│
      │                                                   │
      │  2. 402 Payment Required                          │
      │     PAYMENT-REQUIRED: base64({accepts, ...})      │
      │ <─────────────────────────────────────────────────│
      │                                                   │
      │  3. Decode payment requirements                   │
      │     decode_payment_required_header()              │
      │                                                   │
      │  4. Create signed payment                         │
      │     client.create_payment_payload()               │
      │                                                   │
      │  5. GET /resource                                 │
      │     PAYMENT-SIGNATURE: base64({payload, ...})     │
      │ ─────────────────────────────────────────────────>│
      │                                                   │
      │  6. 200 OK                                        │
      │     PAYMENT-RESPONSE: base64({tx, ...})           │
      │ <─────────────────────────────────────────────────│
      │                                                   │
```

## Setup

1. Copy the environment template:
   ```bash
   cp .env-local .env
   ```

2. Edit `.env` with your configuration:
   - `EVM_PRIVATE_KEY`: Your EVM wallet private key (0x prefixed)
   - `SVM_PRIVATE_KEY`: Your Solana wallet private key (base58)
   - `RESOURCE_SERVER_URL`: The x402-enabled server URL
   - `ENDPOINT_PATH`: The protected endpoint path

3. Install dependencies:
   ```bash
   uv sync
   ```

## Running

```bash
uv run python main.py
```

## Key Implementation Details

### 1. Client Setup

```python
from x402 import x402Client
from x402.mechanisms.evm.exact.register import register_exact_evm_client

client = x402Client()
register_exact_evm_client(client, EthAccountSigner(account))
```

### 2. Detecting Payment Required

```python
response = await http.get(url)

if response.status_code == 402:
    payment_required_header = response.headers.get("PAYMENT-REQUIRED")
    payment_required = decode_payment_required_header(payment_required_header)
```

### 3. Creating Payment

```python
payment_payload = await client.create_payment_payload(payment_required)
payment_header = encode_payment_signature_header(payment_payload)
```

### 4. Retrying with Payment

```python
response = await http.get(
    url,
    headers={"PAYMENT-SIGNATURE": payment_header},
)
```

### 5. Handling Settlement

```python
if response.status_code == 200:
    settlement_header = response.headers.get("PAYMENT-RESPONSE")
    settlement = decode_payment_response_header(settlement_header)
    print(f"Transaction: {settlement.transaction}")
```

## Custom Payment Selection

When multiple payment options are available, you can provide a custom selector:

```python
def select_payment(version: int, requirements: list) -> PaymentRequirements:
    # Prefer Solana if available
    for req in requirements:
        if req.network.startswith("solana:"):
            return req
    return requirements[0]

client = x402Client(payment_requirements_selector=select_payment)
```

## Comparison with Convenience Wrappers

| Aspect | Custom (This Example) | x402HttpxClient |
|--------|----------------------|-----------------|
| Control | Full manual control | Automatic |
| Code | More verbose | Concise |
| Flexibility | Maximum | Limited |
| Use Case | Custom integrations | Standard usage |

## Related Examples

- `../httpx/` - Using the `x402HttpxClient` convenience wrapper
- `../requests/` - Using the `x402_requests` convenience wrapper
- `../advanced/` - Hooks, policies, and builder patterns
