# Builder Code Example Client

Example client for the [builder-code server](../../servers/builder-code/). Makes a paid request and verifies that ERC-8021 builder-code attribution was appended to the settlement transaction calldata.

## Prerequisites

- Go 1.24 or higher
- Running [builder-code server](../../servers/builder-code/) and [builder-code facilitator](../../facilitator/builder-code/)
- EVM private key funded on Base Sepolia

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

2. Fill in the environment variables:

- `EVM_PRIVATE_KEY` — Base Sepolia signer private key (required)
- `EVM_RPC_URL` — JSON-RPC endpoint for on-chain verification (defaults to Base Sepolia)
- `CLIENT_BUILDER_CODE` — Optional client service builder code (`s`)
- `SERVER_URL` — Resource server URL (defaults to `http://localhost:4021/weather`)
- `FACILITATOR_URL` — Facilitator URL (used by the resource server; listed for convenience)

3. Run the client:

```bash
go mod download
go run .
```

On success, the client prints the settlement transaction hash and the builder codes parsed from on-chain calldata (for example `a` for the service app code and `w` for the facilitator wallet code).
