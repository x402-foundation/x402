# x402 FastAPI Example Server

FastAPI server demonstrating how to protect API endpoints with a paywall using the `x402` middleware.

```python
from fastapi import FastAPI
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http import HTTPFacilitatorClient, FacilitatorConfig, PaymentOption
from x402.http.types import RouteConfig
from x402.server import x402ResourceServer
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mechanisms.svm.exact import ExactSvmServerScheme

app = FastAPI()

server = x402ResourceServer(HTTPFacilitatorClient(FacilitatorConfig(url=facilitator_url)))
server.register("eip155:84532", ExactEvmServerScheme())
server.register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", ExactSvmServerScheme())

routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(scheme="exact", price="$0.01", network="eip155:84532", pay_to=evm_address),
            PaymentOption(scheme="exact", price="$0.01", network="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", pay_to=svm_address),
        ]
    ),
}
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)

@app.get("/weather")
async def get_weather():
    return {"weather": "sunny", "temperature": 70}
```

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- Valid EVM address for receiving payments (Base Sepolia)
- Valid SVM address for receiving payments (Solana Devnet)
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

2. Fill required environment variables:

- `EVM_ADDRESS` - Ethereum address to receive payments (Base Sepolia)
- `SVM_ADDRESS` - Solana address to receive payments (Solana Devnet)
- `FACILITATOR_URL` - Facilitator endpoint URL (optional, defaults to production)

3. Install dependencies:

```bash
uv sync
```

4. Run the server:

```bash
uv run python main.py
```

Server runs at http://localhost:4021

## Example Endpoints

| Endpoint | Payment | Price |
|----------|---------|-------|
| `GET /health` | No | - |
| `GET /weather` | Yes | $0.01 USDC |
| `GET /premium/content` | Yes | $0.01 USDC |

## Response Format

### Payment Required (402)

```
$ curl -i http://localhost:4021/weather

HTTP/1.1 402 Payment Required
content-type: application/json
payment-required: <base64-encoded JSON>

{}
```

The `payment-required` header contains base64-encoded JSON with payment requirements.
Note: `amount` is in atomic units (e.g., 10000 = $0.01 USDC, since USDC has 6 decimals):

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4021/weather"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "amount": "10000",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2"
      }
    }
  ]
}
```

### Successful Response (200)

After payment is verified, the protected endpoint returns the requested data:

```
HTTP/1.1 200 OK
content-type: application/json

{"report":{"weather":"sunny","temperature":70}}
```

## Extending the Example

```python
routes = {
    "GET /your-endpoint": RouteConfig(
        accepts=[
            # EVM payment option
            PaymentOption(
                scheme="exact",
                price="$0.10",
                network="eip155:84532",
                pay_to=EVM_ADDRESS,
            ),
            # SVM payment option
            PaymentOption(
                scheme="exact",
                price="$0.10",
                network="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                pay_to=SVM_ADDRESS,
            ),
        ]
    ),
}

@app.get("/your-endpoint")
async def your_endpoint():
    return {"data": "your response"}
```

## Price Configuration

Two ways to specify price:

```python
# String format (uses default USDC)
price="$0.01"

# AssetAmount object (explicit asset)
price=AssetAmount(
    amount="10000",  # $0.01 USDC (6 decimals)
    asset="0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    extra={"name": "USDC", "version": "2"},
)
```

## Network Identifiers

Network identifiers use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:

**EVM Networks:**
- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet

**SVM Networks:**
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet
