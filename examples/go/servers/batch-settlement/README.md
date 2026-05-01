# Batch-Settlement Server (Go)

Go port of [`examples/typescript/servers/batch-settlement`](../../../typescript/servers/batch-settlement). Demo resource server using the batch-settlement scheme: a client opens a payment channel with a single deposit; subsequent paid requests update an off-chain voucher. The `ChannelManager` periodically claims and settles onchain.

The route demonstrates **dynamic pricing**: the client authorizes up to `$0.01` per request, and the handler bills a random fraction of that via `Settlement-Overrides`.

## Run

```bash
cp .env-example .env
# fill in EVM_ADDRESS (the receiver) and FACILITATOR_URL

go run .
```

The server listens on `http://localhost:4021` and exposes `GET /weather`. Pair with `examples/go/clients/batch-settlement` and `examples/go/facilitator/batch-settlement`.

### Cross-SDK local testing

The Go and TS servers share the same `.env-example` keys, route (`GET /weather`), response shape (`{report: {weather, temperature}}`), and channel-manager cadences, so you can swap one for the other without changing client config:

```bash
# Go server
EVM_ADDRESS=0x... FACILITATOR_URL=http://localhost:4022 go run .

# TS server (same .env)
cd examples/typescript/servers/batch-settlement && pnpm dev
```

## Environment

| Variable                              | Required | Description |
|---------------------------------------|----------|-------------|
| `EVM_ADDRESS`                         | yes      | `payTo` address (channel receiver) |
| `FACILITATOR_URL`                     | yes      | Batch-settlement facilitator endpoint (e.g. `http://localhost:4022`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no       | Self-managed authorizer key. **Recommended** — channels survive facilitator changes when you control this key. Omit to delegate to the facilitator's advertised authorizer (existing channels must be drained before switching facilitators). |
| `STORAGE_DIR`                         | no       | If set, persists channel sessions under `${STORAGE_DIR}/server/` |
| `DEFERRED_WITHDRAW_DELAY_SECONDS`     | no       | Channel `withdrawDelay`; defaults to `86400` (1 day) |

## Auto-settlement

The example wires up a `ChannelManager` with the same triggers as the TS demo:

- **Claim** every 60 s.
- **Settle** every 120 s (sweeps claimed funds to `payTo`).
- **Refund** channels idle for 180 s (cooperative — claims first, then refunds the unclaimed remainder to the payer).

For production, choose a `withdrawDelay` greater than your claim cadence plus an operational safety margin.
