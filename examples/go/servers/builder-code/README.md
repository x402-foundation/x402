# Builder Code Example Server

Gin server demonstrating ERC-8021 builder-code attribution on paid endpoints via `buildercode.DeclareBuilderCodeExtension`.

## Prerequisites

- Go 1.24 or higher
- EVM address on Base Sepolia for receiving payments
- URL of a facilitator supporting Base Sepolia (`eip155:84532`); use the [builder-code facilitator](../../facilitator/builder-code/) for full attribution

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

2. Fill in the environment variables:

- `FACILITATOR_URL` — Facilitator endpoint URL (use the [builder-code facilitator](../../facilitator/builder-code/) for full attribution)
- `EVM_ADDRESS` — Base Sepolia address to receive payments
- `APP_BUILDER_CODE` — Your service app builder code (e.g. `bc_weather_svc`)

3. Install dependencies and run:

```bash
go mod download
go run .
```

The server listens on `http://localhost:4021`.

## Testing the Server

Run the [builder-code client](../../clients/builder-code/) against this server:

```bash
cd ../../clients/builder-code
cp .env-example .env
# set EVM_PRIVATE_KEY and FACILITATOR_URL
go run .
```

## Example Endpoint

`GET /weather` requires a payment of $0.001 USDC on Base Sepolia and returns a simple weather report with the server's app builder code (`a`) advertised in the 402 response.
