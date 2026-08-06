# x402 FastAPI Advanced Example

FastAPI server demonstrating advanced x402 patterns including dynamic pricing, payment routing, lifecycle hooks and API discoverability across EVM, SVM, and TVM.

```python
from fastapi import FastAPI
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.http import HTTPFacilitatorClient, FacilitatorConfig, PaymentOption
from x402.http.types import RouteConfig
from x402.server import x402ResourceServer
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.mechanisms.svm.exact import ExactSvmServerScheme
from x402.mechanisms.tvm.exact import ExactTvmServerScheme

app = FastAPI()

server = x402ResourceServer(HTTPFacilitatorClient(FacilitatorConfig(url=facilitator_url)))
server.register("eip155:84532", ExactEvmServerScheme())
server.register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", ExactSvmServerScheme())
server.register("tvm:-3", ExactTvmServerScheme())

routes = {
    "GET /weather": RouteConfig(
        accepts=[
            PaymentOption(scheme="exact", price="$0.01", network="eip155:84532", pay_to=evm_address),
            PaymentOption(scheme="exact", price="$0.01", network="solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", pay_to=svm_address),
            PaymentOption(scheme="exact", price="$0.001", network="tvm:-3", pay_to=tvm_address),
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
- Optional payment addresses for one or more networks:
  - EVM address for Base Sepolia
  - SVM address for Solana Devnet
  - TVM address for TON testnet/mainnet
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

2. Fill required environment variables:

- `EVM_ADDRESS` - Ethereum address to receive payments (Base Sepolia)
- `SVM_ADDRESS` - Solana address to receive payments (Solana Devnet)
- `TVM_ADDRESS` - TON wallet address to receive TVM payments
- `TVM_NETWORK` - TVM CAIP-2 network (optional, defaults to `tvm:-3`)
- `FACILITATOR_URL` - Facilitator endpoint URL (optional, defaults to production)

3. Install dependencies:

```bash
uv sync
```

4. Run the server:

```bash
uv run python all_networks.py       # All supported networks with optional chain configuration
uv run python hooks.py              # Payment lifecycle hooks
uv run python dynamic_price.py      # Dynamic pricing
uv run python dynamic_pay_to.py     # Dynamic payment routing
uv run python custom_token.py       # Custom token parser
uv run python bazaar.py             # Bazaar AI discovery
uv run python paywall.py            # Browser-based payment UI
```

Server runs at http://localhost:4021

## Example Endpoints

| Endpoint | Payment | Price | Feature |
|----------|---------|-------|---------|
| `GET /health` | No | - | Health check |
| `GET /weather` | Yes | $0.01 USDC | Static pricing, Bazaar extension |
| `GET /weather-dynamic` | Yes | $0.001-$0.005 USDC | Dynamic pricing (tier param) |
| `GET /weather-pay-to` | Yes | $0.001 USDC | Dynamic pay-to (country param) |
| `GET /premium/*` | Yes | $0.01 USDC | Paywall with browser UI |

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
            # TVM payment option
            PaymentOption(
                scheme="exact",
                price="$0.10",
                network="tvm:-3",
                pay_to=TVM_ADDRESS,
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

**TVM Networks:**
- `tvm:-3` — TON Testnet
- `tvm:-239` — TON Mainnet

## Advanced Features

### Paywall (Browser Payment UI)

Add a browser-based payment interface for human users:

```python
from x402.http.paywall import create_paywall, evm_paywall, svm_paywall

paywall = (
    create_paywall()
    .with_network(evm_paywall)
    .with_network(svm_paywall)
    .with_config(app_name="My App", testnet=True)
    .build()
)

app.add_middleware(
    PaymentMiddlewareASGI,
    routes=routes,
    server=server,
    paywall_provider=paywall,
)
```

**Use case:** When browser users access a paid endpoint, they see a payment UI instead of raw 402 responses. Supports both EVM (Base) and SVM (Solana) networks.

### Bazaar Extension

Enable AI agent discovery with structured input/output schemas:

```python
from x402.extensions.bazaar import declare_discovery_extension, bazaar_resource_server_extension, OutputConfig

server.register_extension(bazaar_resource_server_extension)

RouteConfig(
    accepts=[...],
    extensions={
        **declare_discovery_extension(
            input={"city": "San Francisco"},
            input_schema={
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
            output=OutputConfig(
                example={"weather": "sunny", "temperature": 70},
                schema={
                    "properties": {
                        "weather": {"type": "string"},
                        "temperature": {"type": "number"},
                    },
                    "required": ["weather", "temperature"],
                },
            ),
        )
    },
)
```

**Use case:** Making your API discoverable by AI agents and automated clients, enabling programmatic service discovery and integration.

### Dynamic Pricing

Set price dynamically based on HTTP request context:

```python
def get_dynamic_price(context: HTTPRequestContext) -> str:
    tier = context.adapter.get_query_param("tier") or "standard"
    return "$0.005" if tier == "premium" else "$0.001"

RouteConfig(
    accepts=[
        PaymentOption(
            scheme="exact",
            price=lambda context: get_dynamic_price(context),
            network=EVM_NETWORK,
            pay_to=EVM_ADDRESS,
        ),
    ],
)
```

**Use case:** Implementing tiered pricing, user-based pricing, content-based pricing or any scenario where the price varies based on the request.

### Dynamic Pay-To

Route payments to different addresses based on request context:

```python
ADDRESS_LOOKUP = {"US": addr_us, "UK": addr_uk, "CA": addr_ca}

def get_dynamic_pay_to(context: HTTPRequestContext) -> str:
    country = context.adapter.get_query_param("country") or "US"
    return ADDRESS_LOOKUP.get(country, default_address)

RouteConfig(
    accepts=[
        PaymentOption(
            scheme="exact",
            pay_to=lambda context: get_dynamic_pay_to(context),
            price="$0.001",
            network=EVM_NETWORK,
        ),
    ],
)
```

**Use case:** Marketplace applications where payments should go to different sellers, content creators, or service providers based on the resource being accessed.

### Hooks

Add custom logic before/after payment verification and settlement:

```python
from x402 import VerifyContext, SettleResultContext, AbortResult

def before_verify_hook(context: VerifyContext) -> None | AbortResult:
    print(f"Verifying payment: {context}")
    # Return AbortResult(reason="...") to abort

def after_settle_hook(context: SettleResultContext) -> None:
    print(f"Payment settled: {context}")

server.on_before_verify(before_verify_hook)
server.on_after_verify(after_verify_hook)
server.on_verify_failure(on_verify_failure_hook)
server.on_before_settle(before_settle_hook)
server.on_after_settle(after_settle_hook)
server.on_settle_failure(on_settle_failure_hook)
```

**Use case:** Log payment events to a database or monitoring system, perform custom validation before processing payments, implement retry or recovery logic for failed payments, trigger side effects (notifications, database updates) after successful payments.

### Custom Tokens

Define custom token conversions for specific networks:

```python
from x402.schemas import AssetAmount

def custom_money_parser(amount: float, network: str) -> AssetAmount | None:
    if network == "eip155:100":  # Gnosis Chain
        return AssetAmount(
            amount=str(int(amount * 1e18)),
            asset="0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",  # WXDAI
            extra={"token": "Wrapped XDAI"},
        )
    return None  # Fall back to default USDC

evm_scheme = ExactEvmServerScheme()
evm_scheme.register_money_parser(custom_money_parser)
server.register(EVM_NETWORK, evm_scheme)
```

**Use case:** When you want to accept payments in tokens other than USDC, or use different tokens based on conditions (e.g., DAI for large amounts, custom tokens for specific networks).
