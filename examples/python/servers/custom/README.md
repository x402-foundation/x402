# x402 Custom Server (Python)

Demonstrates how to implement x402 payment handling manually without using pre-built middleware packages like `x402-fastapi`.

```python
from x402.http import HTTPFacilitatorClient, FacilitatorConfig
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.server import x402ResourceServer

resource_server = x402ResourceServer(
    HTTPFacilitatorClient(FacilitatorConfig(url=facilitator_url))
).register("eip155:84532", ExactEvmServerScheme())

# In your request handler:
if not payment_header:
    payment_required = resource_server.create_payment_required_response([requirements], resource)
    return JSONResponse(status_code=402, headers={"PAYMENT-REQUIRED": encode(payment_required)})

payment_payload = decode(payment_header)
verify_result = await resource_server.verify_payment(payment_payload, requirements)
if not verify_result.is_valid:
    return JSONResponse(status_code=402, content={"error": verify_result.invalid_reason})

# Execute handler, then settle
settle_result = await resource_server.settle_payment(payment_payload, requirements)
response.headers["PAYMENT-RESPONSE"] = encode(settle_result)
```

## Prerequisites

- Python 3.10+ (install via [pyenv](https://github.com/pyenv/pyenv))
- uv (install via [astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- Valid EVM address for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `EVM_ADDRESS` - Ethereum address to receive payments (Base Sepolia)
- `SVM_ADDRESS` - Solana address to receive payments (Solana Devnet)
- `FACILITATOR_URL` - Facilitator endpoint URL (optional, defaults to "https://x402.org/facilitator")

2. Install dependencies:

```bash
uv sync
```

3. Run the server:

```bash
uv run python main.py
```

Or with uvicorn directly:

```bash
uv run uvicorn main:app --host 0.0.0.0 --port 4021 --reload
```

## Testing the Server

You can test the server using one of the example clients:

### Using the httpx Client

```bash
cd ../../clients/httpx
# Ensure .env is setup
uv run python main.py
```

### Using the requests Client

```bash
cd ../../clients/requests
# Ensure .env is setup
uv run python main.py
```

These clients will demonstrate how to:

1. Make an initial request to get payment requirements
2. Process the payment requirements
3. Make a second request with the payment token

## Example Endpoint

The server includes a single example endpoint at `/weather` that requires a payment of 0.001 USDC on Base Sepolia to access. The endpoint returns weather data for a given city.

## HTTP Headers

### Request Headers

When submitting payment, include one of these headers (both are supported for backwards compatibility):

| Header              | Protocol | Description                         |
| ------------------- | -------- | ----------------------------------- |
| `PAYMENT-SIGNATURE` | v2       | Base64-encoded JSON payment payload |
| `X-PAYMENT`         | v1       | Base64-encoded JSON payment payload |

Example request with payment:

```
GET /weather HTTP/1.1
Host: localhost:4021
PAYMENT-SIGNATURE: eyJwYXltZW50IjoiLi4uIn0=
```

### Response Headers

| Header             | Status | Description                                   |
| ------------------ | ------ | --------------------------------------------- |
| `PAYMENT-REQUIRED` | 402    | Base64-encoded JSON with payment requirements |
| `PAYMENT-RESPONSE` | 200    | Base64-encoded JSON with settlement details   |

## Response Format

### Payment Required (402)

```
HTTP/1.1 402 Payment Required
Content-Type: application/json
PAYMENT-REQUIRED: <base64-encoded JSON>

{"error":"Payment Required","message":"This endpoint requires payment"}
```

The `PAYMENT-REQUIRED` header contains base64-encoded JSON with the payment requirements:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4021/weather",
    "description": "Weather data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "1000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2",
        "resourceUrl": "http://localhost:4021/weather"
      }
    }
  ]
}
```

### Successful Response (with payment)

```
HTTP/1.1 200 OK
Content-Type: application/json
PAYMENT-RESPONSE: <base64-encoded JSON>

{"city":"San Francisco","weather":"foggy","temperature":60,"timestamp":"2024-01-01T12:00:00.000000"}
```

The `PAYMENT-RESPONSE` header contains base64-encoded JSON with the settlement details:

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:84532",
  "payer": "0x...",
  "requirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "1000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2",
      "resourceUrl": "http://localhost:4021/weather"
    }
  }
}
```

## Payment Flow

The custom implementation demonstrates each step of the x402 payment flow:

1. **Request Arrives** — Middleware intercepts all requests
2. **Route Check** — Determine if route requires payment
3. **Payment Check** — Look for `PAYMENT-SIGNATURE` or `X-PAYMENT` header
4. **Decision Point**:
   - **No Payment**: Return 402 with requirements in `PAYMENT-REQUIRED` header
   - **Payment Provided**: Verify with facilitator
5. **Verification** — Check payment signature and validity
6. **Handler Execution** — Run protected endpoint handler
7. **Settlement** — Settle payment on-chain (for 2xx responses)
8. **Response** — Add settlement details in `PAYMENT-RESPONSE` header

## Key Implementation Details

### Defining Payment Requirements

```python
from dataclasses import dataclass
from x402.schemas import Network

@dataclass
class RoutePaymentConfig:
    scheme: str
    price: str
    network: Network
    pay_to: str
    description: str
    mime_type: str

route_configs: dict[str, RoutePaymentConfig] = {
    "GET /weather": RoutePaymentConfig(
        scheme="exact",
        price="$0.001",
        network="eip155:84532",
        pay_to=evm_address,
        description="Weather data",
        mime_type="application/json",
    ),
}
```

### Checking for Payment

```python
payment_header = request.headers.get("payment-signature") or request.headers.get("x-payment")

if not payment_header:
    payment_required = resource_server.create_payment_required_response(
        [requirements],
        resource={
            "url": str(request.url),
            "description": route_config.description,
            "mime_type": route_config.mime_type,
        },
    )
    requirements_header = base64.b64encode(
        json.dumps(payment_required.model_dump(by_alias=True)).encode()
    ).decode()

    return JSONResponse(
        status_code=402,
        content={"error": "Payment Required", "message": "This endpoint requires payment"},
        headers={"PAYMENT-REQUIRED": requirements_header},
    )
```

### Verifying Payment

```python
payment_payload_dict = json.loads(base64.b64decode(payment_header).decode("utf-8"))
payment_payload = PaymentPayload.model_validate(payment_payload_dict)
verify_result = await resource_server.verify_payment(payment_payload, requirements)

if not verify_result.is_valid:
    return JSONResponse(
        status_code=402,
        content={"error": "Invalid Payment", "reason": verify_result.invalid_reason},
    )
```

### Settling Payment

```python
settle_result = await resource_server.settle_payment(payment_payload, requirements)
settlement_header = base64.b64encode(
    json.dumps(settle_result.model_dump(by_alias=True)).encode()
).decode()
response.headers["PAYMENT-RESPONSE"] = settlement_header
```

## Middleware vs Custom Comparison

| Aspect                 | With Middleware (PaymentMiddlewareASGI) | Custom Implementation |
| ---------------------- | --------------------------------------- | --------------------- |
| Code Complexity        | ~10 lines                               | ~150 lines            |
| Automatic Verification | ✅ Yes                                  | ❌ Manual             |
| Automatic Settlement   | ✅ Yes                                  | ❌ Manual             |
| Header Management      | ✅ Automatic                            | ❌ Manual             |
| Flexibility            | Limited                                 | ✅ Complete control   |
| Error Handling         | ✅ Built-in                             | ❌ You implement      |
| Maintenance            | x402 team                               | You maintain          |

## When to Use Each Approach

**Use Middleware (PaymentMiddlewareASGI, flask_payment_middleware) when:**

- Building standard applications
- Want quick integration
- Prefer automatic payment handling
- Using supported frameworks (FastAPI, Flask)

**Use Custom Implementation when:**

- Using unsupported frameworks (Starlette, Django, etc.)
- Need complete control over flow
- Require custom error handling
- Want to understand internals
- Building custom abstractions

## Adapting to Other Frameworks

To use this pattern with other frameworks:

1. Create middleware function for your framework
2. Check for payment requirements per route
3. Use `x402ResourceServer` to verify/settle payments
4. Intercept responses to add settlement headers

The pattern in `main.py` can be adapted to any Python ASGI/WSGI web framework.
