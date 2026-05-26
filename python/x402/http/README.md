# x402 HTTP Module

HTTP layer for the x402 Python SDK. Provides facilitator clients, HTTP client wrappers, and server middleware.

## Components

| Component | Async | Sync | Description |
|-----------|-------|------|-------------|
| `HTTPFacilitatorClient` | ✓ | | Async facilitator HTTP client |
| `HTTPFacilitatorClientSync` | | ✓ | Sync facilitator HTTP client |
| `x402HTTPClient` | ✓ | | HTTP-aware payment client wrapper |
| `x402HTTPClientSync` | | ✓ | Sync HTTP payment client |
| `x402HTTPResourceServer` | ✓ | | HTTP server with route config |
| `x402HTTPResourceServerSync` | | ✓ | Sync HTTP server |

## Facilitator Client

Communicates with remote x402 facilitator services.

### Async

```python
from x402.http import HTTPFacilitatorClient, FacilitatorConfig

facilitator = HTTPFacilitatorClient(
    FacilitatorConfig(url="https://x402.org/facilitator")
)

# Get supported payment kinds
supported = await facilitator.get_supported()

# Verify payment
result = await facilitator.verify(payload, requirements)

# Settle payment
settle = await facilitator.settle(payload, requirements)
```

### Sync

```python
from x402.http import HTTPFacilitatorClientSync

facilitator = HTTPFacilitatorClientSync(url="https://x402.org/facilitator")

supported = facilitator.get_supported()
result = facilitator.verify(payload, requirements)
```

### Authentication

```python
from x402.http import FacilitatorConfig, AuthHeaders

class MyAuth:
    async def get_auth_headers(self) -> AuthHeaders:
        return AuthHeaders(
            verify={"Authorization": "Bearer ..."},
            settle={"Authorization": "Bearer ..."},
            supported={},
        )

config = FacilitatorConfig(
    url="https://custom-facilitator.com",
    auth_provider=MyAuth(),
)
```

## HTTP Headers

Encoding/decoding utilities:

```python
from x402.http import (
    encode_payment_signature_header,
    decode_payment_signature_header,
    encode_payment_required_header,
    decode_payment_required_header,
    encode_payment_response_header,
    decode_payment_response_header,
)

# Encode payload to header
header = encode_payment_signature_header(payload)

# Decode from header
payload = decode_payment_signature_header(header_value)
```

## Constants

```python
from x402.http import (
    PAYMENT_SIGNATURE_HEADER,    # "PAYMENT-SIGNATURE"
    PAYMENT_REQUIRED_HEADER,     # "PAYMENT-REQUIRED"
    PAYMENT_RESPONSE_HEADER,     # "PAYMENT-RESPONSE"
    X_PAYMENT_HEADER,            # "X-PAYMENT" (V1)
    X_PAYMENT_RESPONSE_HEADER,   # "X-PAYMENT-RESPONSE" (V1)
    HTTP_STATUS_PAYMENT_REQUIRED, # 402
    DEFAULT_FACILITATOR_URL,
)
```

## Submodules

- `x402.http.clients` - HTTP client wrappers (httpx, requests)
- `x402.http.middleware` - Framework middleware (FastAPI, Flask)

## Route Configuration

```python
from x402.http import RouteConfig, PaymentOption, RoutesConfig

routes: RoutesConfig = {
    "GET /api/weather/*": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                network="eip155:84532",
                pay_to="0x...",
                price="$0.01",
            ),
        ],
        description="Weather API",
    ),
}
```

### Dynamic Pricing

```python
def get_price(context):
    if context.path.endswith("/premium"):
        return "$0.10"
    return "$0.01"

routes = {
    "GET /api/*": RouteConfig(
        accepts=[
            PaymentOption(
                scheme="exact",
                network="eip155:84532",
                pay_to="0x...",
                price=get_price,  # Dynamic
            ),
        ],
    ),
}
```

