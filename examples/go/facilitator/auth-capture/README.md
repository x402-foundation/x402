# Auth-Capture Facilitator (Go)

Standalone HTTP facilitator with the auth-capture EVM scheme registered for
Base Sepolia. Exposes the standard x402 endpoints:

- `GET /supported`
- `POST /verify`
- `POST /settle`

This facilitator is the escrow operator (`captureAuthorizer`): it verifies and
settles the client's initial authorize (collect) onchain, then later relays
the resource server's signed `capture`/`void` lifecycle calls.

## Run

```bash
cp .env-example .env
# fill in EVM_PRIVATE_KEY

go run .
```

Listens on `http://localhost:4022` by default (`PORT` overrides).

## Environment

| Variable             | Description |
|-----------------------|-------------|
| `EVM_PRIVATE_KEY` (required) | Facilitator/operator wallet — signs and submits onchain transactions |
| `EVM_RPC_URL`         | Default `https://sepolia.base.org` |
| `FEE_RECIPIENT`       | Optional advertised fee recipient |
| `MIN_FEE_BPS`/`MAX_FEE_BPS` | Optional advertised fee bounds |
| `PORT`                | Listen port (default `4022`) |
