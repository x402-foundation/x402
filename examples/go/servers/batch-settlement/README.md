# Batch-Settlement Server (Go)

Demo resource server using the batch-settlement scheme. A client opens a payment
channel with a single deposit; subsequent paid requests update an off-chain
voucher. The `ChannelManager` periodically claims and settles on-chain.

Demonstrates dynamic pricing: each request charges a random fraction of
`maxPrice` via `Settlement-Overrides`.

## Run

```bash
cp .env.example .env
# fill in EVM_ADDRESS (the receiver) and FACILITATOR_URL

go run .
```

Pair with `examples/go/clients/batch-settlement` and
`examples/go/facilitator/batch-settlement`.

### Cross-SDK local testing

Use `FACILITATOR_URL=http://localhost:4022` with the local facilitator. The same
env keys and defaults match `examples/typescript/servers/batch-settlement/.env-example`
so you can run the Express server instead of this binary without changing
variables. Response JSON from `GET /api/generate` includes `usage.maxPrice`,
`usage.chargedRatio`, and `usage.chargedPrice` in both implementations for
assertion parity.

## Environment

| Variable                                  | Description |
|-------------------------------------------|-------------|
| `EVM_ADDRESS` (required)                  | Receiver address (settlement payout target) |
| `FACILITATOR_URL` (required)              | Facilitator base URL (e.g. `http://localhost:4022`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`     | Optional self-managed authorizer key. **Recommended** — channels survive facilitator changes when you control this key. Omit to delegate to the facilitator's advertised authorizer (existing channels must be drained before switching facilitators). |
| `STORAGE_DIR`                             | If set, persists session state under `${STORAGE_DIR}/server/` |
| `DEFERRED_WITHDRAW_DELAY_SECONDS`         | Channel withdraw delay (default 900 = 15 min) |

## Auto-settlement triggers

The example wires up a `ChannelManager` with all three triggers active:

- **Claim** every 10s (or on detected withdrawal).
- **Settle** every 20s (sweeps claimed funds to `payTo`).
- **Refund** channels idle for 30s (cooperative — claims first, then refunds the
  unclaimed remainder to the payer).
