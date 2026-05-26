# Sign-In-With-X (SIWX) Server Example

FastAPI server demonstrating both SIWX patterns supported by x402:
- Auth-only routes that require a wallet signature but no payment
- Paid routes where a wallet can pay once, then authenticate with SIWX on later requests

```python
from fastapi import FastAPI

from x402.extensions.sign_in_with_x import (
    CreateSIWxHookOptions,
    InMemorySIWxStorage,
    create_siwx_resource_server_extension,
    declare_siwx_extension,
)
from x402.http import FacilitatorConfig, HTTPFacilitatorClient
from x402.http.middleware.fastapi import PaymentMiddlewareASGI
from x402.mechanisms.evm.exact import ExactEvmServerScheme
from x402.server import x402ResourceServer

storage = InMemorySIWxStorage()

facilitator = HTTPFacilitatorClient(FacilitatorConfig(url=facilitator_url))
server = x402ResourceServer(facilitator)
server.register("eip155:84532", ExactEvmServerScheme())
server.register_extension(
    create_siwx_resource_server_extension(
        CreateSIWxHookOptions(storage=storage, on_event=on_event)
    )
)

app = FastAPI()
app.add_middleware(PaymentMiddlewareASGI, routes=routes, server=server)
```

## How It Works

1. **Auth-only route** — Server returns a SIWX challenge and grants access on a valid signature alone
2. **Paid route** — First request requires payment
3. **Server records** — Payment is recorded against the wallet address in storage
4. **Later paid-route request** — Signature proves wallet ownership and grants access without re-payment

## Prerequisites

- Python 3.10+
- [uv](https://docs.astral.sh/uv/) package manager
- At least one payout address: EVM, SVM, or both
- Facilitator URL (see [facilitator list](https://www.x402.org/ecosystem?category=facilitators))

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `FACILITATOR_URL` — Facilitator endpoint URL
- `EVM_ADDRESS` — (Optional) Ethereum address to receive payments
- `SVM_ADDRESS` — (Optional) Solana address for SVM payments

At least one of `EVM_ADDRESS` or `SVM_ADDRESS` is required.

2. Install dependencies:

```bash
uv sync
```

3. Run the server:

```bash
uv run python main.py
```

Server listens on port **4021**.

## Testing the Server

Start the SIWX client to test:

```bash
cd ../../clients/sign-in-with-x
# Ensure .env is setup with EVM_PRIVATE_KEY or SVM_PRIVATE_KEY
uv sync
uv run python main.py
```

The client will:
1. Access `/profile` with SIWX and no payment
2. Make first request and pay for `/weather`
3. Make second request to `/weather` with SIWX instead of payment
4. Make first request and pay for `/joke`
5. Make second request to `/joke` with SIWX instead of payment

## Example Endpoints

- `GET /profile` — Auth-only wallet-gated profile data (no payment)
- `GET /weather` — Weather data ($0.001 USDC)
- `GET /joke` — Joke content ($0.001 USDC)

`/profile` requires only a valid SIWX signature. `/weather` and `/joke` require payment once per wallet address, then accept SIWX on later requests.

## SIWX Extension Configuration

The server uses two key components:

### 1. Extension Declaration

```python
routes = {
    "GET /weather": RouteConfig(
        accepts=[PaymentOption(scheme="exact", price="$0.001", network="eip155:84532", pay_to=evm_address)],
        description="Protected resource: /weather",
        mime_type="application/json",
        extensions=declare_siwx_extension(),  # Announces SIWX support
    ),
    "GET /profile": RouteConfig(
        accepts=[],
        description="Auth-only: wallet signature required",
        extensions=declare_siwx_extension(
            DeclareSIWxOptions(
                network=["eip155:84532", "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"],
                statement="Sign in to view your profile",
                expiration_seconds=300,
            )
        ),
    ),
}
```

For auth-only routes, `network` must be declared explicitly because there is no payment option to infer it from. Paid routes derive network from their `accepts` options automatically.

### 2. Server Extension

```python
server = x402ResourceServer(facilitator)
if EVM_ADDRESS:
    server.register("eip155:84532", ExactEvmServerScheme())
if SVM_ADDRESS:
    server.register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", ExactSvmServerScheme())

server.register_extension(
    create_siwx_resource_server_extension(
        CreateSIWxHookOptions(storage=storage, on_event=on_event)
    )
)
```

The extension refreshes SIWX challenges, records successful payments, and checks SIWX proofs for routes that declare `sign-in-with-x`. For routes declared with `accepts: []`, it grants access on valid SIWX alone. For paid routes, it also checks whether that wallet has already paid.

The `/profile` handler reads the verified address from the request header:

```python
@app.get("/profile")
async def profile(request: Request) -> JSONResponse:
    header = request.headers.get("sign-in-with-x") or request.headers.get("SIGN-IN-WITH-X")
    payload = parse_siwx_header(header or "")
    return JSONResponse({"address": payload.address, "data": "Your profile data"})
```

## Storage Backend

This example uses in-memory storage (`InMemorySIWxStorage`). For production, implement persistent storage:

```python
from x402.extensions.sign_in_with_x import SIWxStorage

class RedisSIWxStorage:
    def has_paid(self, resource: str, address: str) -> bool:
        # Check Redis/database
        ...

    def record_payment(self, resource: str, address: str) -> None:
        # Store in Redis/database
        ...

storage = RedisSIWxStorage()
```

## Optional SVM Support

To enable Solana (SVM) payments, provide `SVM_ADDRESS` in `.env`. The server registers both schemes when both addresses are set:

```python
if EVM_ADDRESS:
    server.register("eip155:84532", ExactEvmServerScheme())
if SVM_ADDRESS:
    server.register("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", ExactSvmServerScheme())
```

Each paid route includes a `PaymentOption` for every configured network.

## Event Logging

Monitor SIWX events via the `on_event` callback:

```python
def on_event(event: dict) -> None:
    print(f"[SIWX] {event['type']}", event)

create_siwx_resource_server_extension(
    CreateSIWxHookOptions(storage=storage, on_event=on_event)
)
```

Event types:
- `payment_recorded` — Wallet paid for resource
- `access_granted` — SIWX signature verified and access granted
- `validation_failed` — Header parsing, message validation, or signature verification failed
- `nonce_reused` — A previously used SIWX nonce was replayed

## Environment Variables

| Variable | Description |
|----------|-------------|
| `FACILITATOR_URL` | Facilitator endpoint URL (required) |
| `EVM_ADDRESS` | Ethereum address to receive EVM payments |
| `SVM_ADDRESS` | Solana address to receive SVM payments |

**Note:** At least one of `EVM_ADDRESS` or `SVM_ADDRESS` must be provided.

## Learn More

- [x402 Python SDK](../../../../python/x402/)
- [SIWX extension](../../../../python/x402/extensions/sign_in_with_x/)
- [TypeScript server example](../../../typescript/servers/sign-in-with-x/)
