# Batch-Settlement Streaming Server (Go)

SSE LLM-style streaming server gated by x402 batch-settlement. Streams a
simulated token stream chunk-by-chunk, requesting voucher renewals from the
client mid-stream when the chunk-debit reaches the signed cap.

Mirrors `examples/typescript/servers/batch-settlement-streaming/index.ts`. The
TS variant optionally calls OpenAI; this Go example uses the simulated stream
only.

## Routes

- `GET  /llm/stream?prompt=<text>` — SSE endpoint, gated by `PAYMENT-SIGNATURE`
- `POST /x402/voucher/{channelId}` — voucher renewal side-channel

## Run

```bash
cp .env.example .env
# fill EVM_ADDRESS and FACILITATOR_URL

go run . --verbose
```

The server listens on `:4021`.

## Flow

1. Initial `GET /llm/stream` without `PAYMENT-SIGNATURE` → `402 PAYMENT-REQUIRED`.
2. Client retries with the deposit-and-voucher payload. The server settles the
   deposit on-chain (charging one chunk worth in the same transaction), then
   begins streaming.
3. After every `CHUNK_SIZE` tokens, the server settles the chunk via the
   batched-voucher path and emits `event: x402-voucher-needed` with the new
   charged total and a `voucherEndpoint`.
4. The client POSTs a fresh voucher (or top-up deposit) to that endpoint. The
   server verifies, optionally settles a renewal deposit, and emits
   `event: x402-voucher-accepted`.
5. After the last token, the server settles any partial chunk, emits
   `event: x402-settlement` and `event: done`, and writes the
   `PAYMENT-RESPONSE` HTTP trailer with totals for the request lifetime.

## Environment

| Variable                              | Description |
|---------------------------------------|-------------|
| `EVM_ADDRESS` (required)              | Receiver address (0x-prefixed checksummed) |
| `FACILITATOR_URL` (required)          | Facilitator HTTP endpoint |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | Local signer for receiver-authorizer (otherwise facilitator signs) |
| `STORAGE_DIR`                         | If set, persists session state to disk |
| `CHUNK_SIZE`                          | Tokens per priced chunk (default `100`) |
| `DEFERRED_WITHDRAW_DELAY_SECONDS`     | Withdraw delay; minimum enforced by contract |
| `VERBOSE`                             | Truthy enables voucher-event logging |
