# Batch-Settlement Client (Go)

Sequential batch-settlement payment client. Opens a payment channel on the
first request (deposit) and pays subsequent requests with off-chain vouchers
that update cumulative claimable amount.

## Run

```bash
cp .env.example .env
# fill in EVM_PRIVATE_KEY and (optional) FILE_STORAGE_DIR

go run .
```

The companion server is in `examples/go/servers/batch-settlement` and the
facilitator is in `examples/go/facilitator/batch-settlement`.

## Environment

| Variable                          | Description |
|-----------------------------------|-------------|
| `EVM_PRIVATE_KEY` (required)      | Payer private key (0x-prefixed hex) |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY`  | Optional dedicated voucher-signing EOA (recommended for smart wallets) |
| `RESOURCE_SERVER_URL`             | Default `http://localhost:4021` |
| `ENDPOINT_PATH`                   | Default `/api/generate` |
| `CHANNEL_SALT`                    | 32-byte hex; default `0x000…000` |
| `STORAGE_DIR`                     | If set, persists session state under `${STORAGE_DIR}/client/` |
| `NUMBER_OF_REQUESTS`              | Default `3` |
| `REFUND_AFTER_REQUESTS`           | If `"true"`, requests a cooperative refund after the request loop completes |
| `REFUND_AMOUNT`                   | Optional partial refund amount in base units. Empty drains remaining channel balance |
