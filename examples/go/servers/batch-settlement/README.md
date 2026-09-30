# Batch-Settlement Server (Go)

Demo resource server using the batch-settlement scheme on Base Sepolia and/or Solana Devnet. A client opens a payment channel with a single deposit; subsequent paid requests update an off-chain voucher. Channel managers periodically claim and settle onchain.

The route demonstrates **dynamic pricing on EVM**: the client authorizes up to `$0.01` per request, and the handler bills a random fraction via `Settlement-Overrides`. SVM batch-settlement is fixed-price by default; set `SVM_OPERATOR_PRIVATE_KEY` to also offer the route **server-signed** (metered charge signed by the operator, with a client-signed accept at the ceiling for untrusted clients).

## Run

```bash
cp .env-example .env
# fill in at least one of EVM_ADDRESS or SVM_ADDRESS, plus FACILITATOR_URL

go run .
```

The server listens on `http://localhost:4021` and exposes `GET /weather`. Pair with `examples/go/clients/batch-settlement` and `examples/go/facilitator/batch-settlement`. Env keys match `examples/typescript/servers/batch-settlement/.env-local`.

## Environment

| Variable | Description |
|----------|-------------|
| `EVM_ADDRESS` | EVM `payTo` (optional if `SVM_ADDRESS` is set) |
| `SVM_ADDRESS` | Solana `payTo` (optional if `EVM_ADDRESS` is set) |
| `FACILITATOR_URL` | Batch-settlement facilitator (e.g. `http://localhost:4022`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | Optional EVM cooperative claim/refund signer |
| `SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | Required when `SVM_ADDRESS` is set (base58) |
| `SVM_OPERATOR_PRIVATE_KEY` | Optional SVM operator for server-signed metering (base58) |
| `SVM_RPC_URL` | Solana RPC for redemption worker (optional) |
| `STORAGE_DIR` | EVM file-backed channel storage (optional) |
| `DEFERRED_WITHDRAW_DELAY_SECONDS` | Channel withdraw delay (default `86400`) |
