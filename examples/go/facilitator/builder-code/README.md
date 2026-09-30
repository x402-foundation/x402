# Builder Code Facilitator Example

Gin facilitator that verifies and settles payments on Base Sepolia and appends ERC-8021 wallet attribution (`w`) at settlement via `buildercode.BuilderCodeFacilitatorExtension`.

## Prerequisites

- Go 1.24 or higher
- Dedicated EVM facilitator private key with Base Sepolia ETH for transaction fees

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

2. Fill in the environment variables:

- `EVM_PRIVATE_KEY` — Base Sepolia facilitator private key
- `FACILITATOR_BUILDER_CODE` — Facilitator wallet builder code (e.g. `bc_example_facilitator`, optional)
- `PORT` — Server port (optional, defaults to `4022`)

**Security note:** The facilitator key is the signer used to settle payments on-chain. Keep it separate from your seller `payTo` wallet and buyer test wallets, and fund it only for facilitator gas/fees.

3. Run the facilitator:

```bash
go mod download
go run .
```

## API Endpoints

- `GET /supported` — Returns supported payment schemes and networks
- `GET /health` — Health check
- `POST /verify` — Verifies a payment payload against requirements
- `POST /settle` — Settles a verified payment on-chain (appends builder-code suffix when configured)

## Usage with the Builder Code Server

Point the [builder-code server](../../servers/builder-code/) at this facilitator:

```bash
# In servers/builder-code/.env
FACILITATOR_URL=http://localhost:4022
```

Then run the [builder-code client](../../clients/builder-code/) to exercise the full attribution flow.
