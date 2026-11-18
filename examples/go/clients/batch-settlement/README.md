# Batch-Settlement Client (Go)

Sequential batch-settlement payment client for Base Sepolia and/or Solana Devnet. Opens a payment channel on the first request (deposit) and pays subsequent requests with off-chain vouchers.

## Run

```bash
cp .env-example .env
# fill in at least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY

go run .
```

Pair with `examples/go/servers/batch-settlement` and `examples/go/facilitator/batch-settlement`. Env keys match `examples/typescript/clients/batch-settlement/.env-local`.

## SVM server-signed channels

Set `SVM_SERVER_SIGNED_OPERATORS` to a comma-separated list of operator pubkeys you trust (must match the server's `SVM_OPERATOR_PRIVATE_KEY` pubkey when testing server-signed mode). Optional `SVM_SERVER_SIGNED_MAX_DEPOSIT` caps escrow (default `$0.05`). The client registers `PaymentPolicy()` so untrusted server-signed accepts are dropped and trusted operators are preferred.

## Environment

| Variable | Description |
|----------|-------------|
| `EVM_PRIVATE_KEY` | EVM payer (optional if `SVM_PRIVATE_KEY` is set) |
| `SVM_PRIVATE_KEY` | Base58 Solana payer (optional if `EVM_PRIVATE_KEY` is set) |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY` | Optional EVM voucher delegate |
| `EVM_RPC_URL` | EVM RPC for cold-start recovery (default Sepolia) |
| `SVM_RPC_URL` | Solana RPC (optional) |
| `SVM_SERVER_SIGNED_OPERATORS` | Trusted operator pubkeys for metered server-signed channels |
| `SVM_SERVER_SIGNED_MAX_DEPOSIT` | USD escrow cap per server-signed channel |
| `RESOURCE_SERVER_URL` / `ENDPOINT_PATH` | Target resource (default `http://localhost:4021` + `/weather`) |
| `CHANNEL_SALT` / `SVM_CHANNEL_SALT` | Channel identity salts |
| `DEPOSIT_MULTIPLIER` | Deposit sizing when `extra.minDeposit` is absent (default `5`) |
| `STORAGE_DIR` | EVM file-backed client storage (optional) |
| `NUMBER_OF_REQUESTS` | Paid requests to send (default `3`) |
| `REFUND_AFTER_REQUESTS` | Cooperative refund after the loop (`true` / `false`) |
| `REFUND_AMOUNT` | EVM partial refund in base units; SVM supports full refund only |
