# Builder Code Extension Server Example

Example server demonstrating ERC-8021 builder-code attribution on paid endpoints via `declare_builder_code_extension`.

```python
from x402.extensions.builder_code import BUILDER_CODE, declare_builder_code_extension
from x402.server import x402ResourceServer

server = x402ResourceServer(facilitator)
server.register("eip155:84532", ExactEvmServerScheme())

routes = {
    "GET /weather": RouteConfig(
        accepts=[PaymentOption(scheme="exact", price="$0.001", network="eip155:84532", pay_to=evm_address)],
        description="Weather data",
        mime_type="application/json",
        extensions={
            BUILDER_CODE: declare_builder_code_extension(app_builder_code),
        },
    ),
}
```

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- EVM address on Base Sepolia for receiving payments
- URL of a facilitator supporting Base Sepolia (`eip155:84532`); use the [builder-code facilitator](../facilitator/builder-code/) for full attribution

## Setup

1. Install dependencies:

```bash
uv sync
```

2. Copy `.env-local` to `.env` and fill required environment variables:

```bash
cp .env-local .env
```

- `FACILITATOR_URL` — Facilitator endpoint URL (use the [builder-code facilitator](../facilitator/builder-code/) for full attribution)
- `EVM_ADDRESS` — Base Sepolia address to receive payments
- `APP_BUILDER_CODE` — Your service app builder code (e.g. `bc_weather_svc`)

3. Run the server:

```bash
uv run python main.py
```

The server listens at `http://localhost:4021`.

## Testing the Server

You can test the server using the example client:

```bash
cd ../../clients/builder-code
cp .env-local .env
# Fill in EVM_PRIVATE_KEY and CLIENT_BUILDER_CODE
uv sync
uv run python main.py
```

The client will:

1. Make a paid request to `/weather`
2. Process the payment via the facilitator
3. Verify ERC-8021 builder-code attribution in the settlement transaction calldata

## Example Endpoint

The server includes a single example endpoint at `/weather` that requires a payment of 0.001 USDC on Base Sepolia to access. The endpoint returns a simple weather report.

## Network Identifiers

Networks use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format:

- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet

## Next Steps

See [Advanced Examples](../advanced/) for:

- **Bazaar discovery** — make your API discoverable
- **Dynamic pricing** — price based on request context
- **Dynamic payTo** — route payments to different recipients
- **Lifecycle hooks** — custom logic on verify/settle
- **Custom tokens** — accept payments in custom tokens
