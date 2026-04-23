# Batch-Settlement Streaming Client (Go)

Streaming batch-settlement client. Pays once, opens a channel, then consumes a
Server-Sent Events stream while renewing vouchers mid-stream when the server
signals via `x402-voucher-needed`.

Mirrors `examples/typescript/clients/batch-settlement-streaming/index.ts`.

## Run

```bash
cp .env.example .env
# fill in EVM_PRIVATE_KEY (optional STORAGE_DIR, EVM_VOUCHER_SIGNER_PRIVATE_KEY)

go run . --prompt "Explain channels in one paragraph" --verbose
```

Flags:

| Flag                | Description                                  |
|---------------------|----------------------------------------------|
| `--prompt`, `-p`    | Prompt text (falls back to `PROMPT` env var) |
| `--verbose`, `-v`   | Log every voucher / settlement event         |

## Flow

1. Initial `GET /llm/stream` returns `402` with payment requirements.
2. Client builds the first deposit + voucher payload and re-sends with the
   `PAYMENT-SIGNATURE` header.
3. Server streams tokens as `event: data` SSE frames.
4. When the server's chunk-debit hits the signed voucher cap, it emits
   `event: x402-voucher-needed` with the channel snapshot.
5. Client `ProcessSettleResponse`s the snapshot, builds a fresh voucher
   (or top-up deposit if the channel balance is insufficient), and POSTs it to
   the supplied `voucherEndpoint`.
6. Server emits `event: x402-voucher-accepted` and resumes streaming. After
   the final token, an `event: x402-settlement` frame conveys the last signed
   voucher.
7. The HTTP `PAYMENT-RESPONSE` trailer is read after the body completes.

## Environment

| Variable                          | Description |
|-----------------------------------|-------------|
| `EVM_PRIVATE_KEY` (required)      | Payer private key (0x-prefixed hex) |
| `EVM_VOUCHER_SIGNER_PRIVATE_KEY`  | Optional dedicated voucher-signing EOA |
| `RESOURCE_SERVER_URL`             | Default `http://localhost:4021` |
| `CHANNEL_SALT`                    | 32-byte hex salt for channel derivation |
| `STORAGE_DIR`                     | If set, persists per-channel session state |
| `PROMPT`                          | Default prompt (overridden by `--prompt`) |
| `VERBOSE`                         | Truthy enables voucher-event logging |
