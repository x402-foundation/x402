# Batch-Settlement Facilitator (Go)

Standalone HTTP facilitator with the batch-settlement EVM scheme registered for
Base Sepolia. Exposes the standard x402 endpoints:

- `GET /supported`
- `POST /verify`
- `POST /settle`

The facilitator's `evmSigner` submits onchain transactions for `deposit`,
`claimWithSignature`, `settle`, and `refundWithSignature`. The `authorizerSigner`
produces the EIP-712 signatures advertised in `/supported.kinds[].extra.receiverAuthorizer`.

Servers may delegate to the facilitator's authorizer (omit
`EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` on the server) or run a self-managed authorizer.

## Run

```bash
cp .env-example .env
# fill in EVM_PRIVATE_KEY

go run .
```

Listens on `http://localhost:4022` by default (`PORT` overrides).

## Environment

| Variable                                  | Description |
|-------------------------------------------|-------------|
| `EVM_PRIVATE_KEY` (required)              | Facilitator wallet — signs and submits onchain transactions |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`     | Optional dedicated authorizer key. Defaults to `EVM_PRIVATE_KEY`. |
| `EVM_RPC_URL`                             | Default `https://sepolia.base.org` |
| `PORT`                                    | Listen port (default `4022`) |
