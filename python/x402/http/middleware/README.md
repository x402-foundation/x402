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

## Browser Clients (CORS)

Both middlewares add `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE` to `Access-Control-Expose-Headers` on every response that carries one of them (the 402, settlement failures, and settled responses). An expose list already on the response is merged case-insensitively, not replaced. They never set `Access-Control-Allow-Origin`; that comes from your CORS setup, which must also reach the 402.

Your CORS setup must also:

- name `PAYMENT-SIGNATURE` explicitly in the allowed request headers (`*` is not a wildcard for credentialed requests);
- answer the `OPTIONS` preflight with a 2xx without requiring payment (key paid routes with their method, e.g. `GET /api/weather`);
- send `Vary: Origin` if it reflects the request's `Origin` instead of `*`, so a shared cache never serves one origin's response to another.

**FastAPI:** add `CORSMiddleware` after the payment middleware so it wraps it and sees the 402. If you pass `expose_headers`, Starlette replaces the expose list, so include the payment headers:

```python
from fastapi.middleware.cors import CORSMiddleware

app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["https://app.example.com"],
    allow_headers=["Content-Type", "PAYMENT-SIGNATURE"],
    expose_headers=["PAYMENT-REQUIRED", "PAYMENT-RESPONSE"],
)
```

**Flask:** `FlaskPaymentMiddleware` replaces `app.wsgi_app`, so the 402 is returned before Flask's `after_request` hooks run and flask-cors never sees it. flask-cors still applies to paid responses, and its expose list is merged. For the 402 to carry `Access-Control-Allow-Origin`, wrap `app.wsgi_app` after installing the payment middleware, and only add the header when flask-cors has not already set it (two values is an invalid header):

```python
FlaskPaymentMiddleware(app, routes, server)

payment_wsgi = app.wsgi_app


def cors_wsgi(environ, start_response):
    def start(status, headers, exc_info=None):
        if not any(k.lower() == "access-control-allow-origin" for k, _ in headers):
            headers = [*headers, ("Access-Control-Allow-Origin", "https://app.example.com")]
        return start_response(status, headers, exc_info)

    return payment_wsgi(environ, start)


app.wsgi_app = cors_wsgi
```

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

