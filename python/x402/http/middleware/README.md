# x402 HTTP Middleware

Server-side middleware for protecting routes with x402 payments.

## FastAPI (Async)

```bash
uv add x402[fastapi]
```

### Basic Usage

```python
from fastapi import FastAPI
from x402 import x402ResourceServer
from x402.http import HTTPFacilitatorClient
from x402.http.middleware import payment_middleware
from x402.mechanisms.evm.exact import ExactEvmServerScheme

app = FastAPI()

# Configure server
facilitator = HTTPFacilitatorClient()
server = x402ResourceServer(facilitator)
server.register("eip155:*", ExactEvmServerScheme())

# Define protected routes
routes = {
    "GET /api/weather/*": {
        "accepts": {
            "scheme": "exact",
            "payTo": "0x...",
            "price": "$0.01",
            "network": "eip155:84532",
        },
        "description": "Weather API",
    },
}

# Add middleware
@app.middleware("http")
async def x402_middleware(request, call_next):
    return await payment_middleware(routes, server)(request, call_next)
```

### ASGI Middleware Class

```python
from x402.http.middleware import PaymentMiddlewareASGI

app.add_middleware(
    PaymentMiddlewareASGI,
    routes=routes,
    server=server,
    paywall_config={"appName": "My API"},
)
```

### Accessing Payment Info

```python
@app.get("/api/weather")
async def weather(request: Request):
    payload = request.state.payment_payload
    requirements = request.state.payment_requirements
    return {"weather": "sunny", "payer": payload.accepted.payTo}
```

## Flask (Sync)

```bash
uv add x402[flask]
```

### Basic Usage

```python
from flask import Flask, g
from x402 import x402ResourceServerSync
from x402.http import HTTPFacilitatorClientSync
from x402.http.middleware import PaymentMiddleware
from x402.mechanisms.evm.exact import ExactEvmServerScheme

app = Flask(__name__)

# Configure server (sync variant)
facilitator = HTTPFacilitatorClientSync(url="https://x402.org/facilitator")
server = x402ResourceServerSync(facilitator)
server.register("eip155:*", ExactEvmServerScheme())

# Define routes
routes = {
    "GET /api/weather/*": {
        "accepts": {
            "scheme": "exact",
            "payTo": "0x...",
            "price": "$0.01",
            "network": "eip155:84532",
        },
    },
}

# Add middleware
PaymentMiddleware(app, routes, server)

@app.route("/api/weather")
def weather():
    payload = g.payment_payload
    return {"weather": "sunny"}
```

### Convenience Function

```python
from x402.http.middleware import payment_middleware

payment_middleware(app, routes, server, paywall_config={"appName": "My API"})
```

## Sync/Async Matching

| Framework | Server | Facilitator Client |
|-----------|--------|-------------------|
| FastAPI | `x402ResourceServer` | `HTTPFacilitatorClient` |
| Flask | `x402ResourceServerSync` | `HTTPFacilitatorClientSync` |

Using async components with Flask raises `TypeError`.

## Route Patterns

| Pattern | Matches |
|---------|---------|
| `GET /api/weather` | Only GET to /api/weather |
| `/api/users/*` | Any method to /api/users/* |
| `POST /api/users/[id]` | POST to /api/users/123 |
| `* /api/*` | Any method to /api/* |

## Paywall Configuration

```python
paywall_config = {
    "appName": "My API",
    "appLogo": "/logo.png",
    "testnet": True,
}

PaymentMiddleware(app, routes, server, paywall_config=paywall_config)
```

Browser requests to protected routes show an HTML paywall. API requests receive 402 with `PAYMENT-REQUIRED` header.

## Custom Paywall

```python
from x402.http import PaywallProvider

class MyPaywall(PaywallProvider):
    def generate_html(self, payment_required, config):
        return "<html>Custom paywall...</html>"

PaymentMiddleware(app, routes, server, paywall_provider=MyPaywall())
```

## Exports

### FastAPI

| Export | Description |
|--------|-------------|
| `payment_middleware()` | Create middleware function |
| `payment_middleware_from_config()` | Create from config dict |
| `PaymentMiddlewareASGI` | ASGI middleware class |
| `FastAPIAdapter` | HTTPAdapter for FastAPI |

### Flask

| Export | Description |
|--------|-------------|
| `PaymentMiddleware` | WSGI middleware class |
| `payment_middleware()` | Convenience function |
| `payment_middleware_from_config()` | Create from config dict |
| `FlaskAdapter` | HTTPAdapter for Flask |

