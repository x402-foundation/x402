# Batch-Settlement Concurrent Client (Go)

Concurrent batch-settlement client. Opens N independent channels (one per
unique salt) and fires one request per channel per round in parallel.
The server serialises per-channel, not globally — so concurrent slots make
progress independently.

Mirrors `examples/typescript/clients/batch-settlement/concurrent.ts`.

## Run

```bash
cp .env.example .env
# fill in EVM_PRIVATE_KEY (optional STORAGE_DIR, EVM_VOUCHER_SIGNER_PRIVATE_KEY)

go run .
```

## Environment

| Variable                          | Description |
|-----------------------------------|-------------|
| `EVM_PRIVATE_KEY` (required)      | Payer private key (0x-prefixed hex) |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY`  | Optional dedicated voucher-signing EOA |
| `RESOURCE_SERVER_URL`             | Default `http://localhost:4021` |
| `ENDPOINT_PATH`                   | Default `/api/generate` |
| `CHANNEL_SALT`                    | 32-byte hex base; each channel uses base + index |
| `STORAGE_DIR`                     | If set, persists per-channel session state |
| `CONCURRENCY`                     | Channels run in parallel (default `3`) |
| `NUMBER_OF_CHANNELS`              | Number of rounds (default `3`) |
