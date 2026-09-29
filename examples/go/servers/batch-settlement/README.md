# Batch-Settlement Server (Go)

Demo resource server using the batch-settlement scheme: a client opens a payment channel with a single deposit; subsequent paid requests update an off-chain voucher. The `ChannelManager` periodically claims and settles onchain.

The route demonstrates **dynamic pricing**: the client authorizes up to `$0.01` per request, and the handler bills a random fraction of that via `Settlement-Overrides`. Every 402 also includes `extra.minDeposit` (SDK default `10 × amount`) so clients can size the channel deposit. Override per route with `accepts.extra.minDeposit` (`"$0.10"` on the default asset, or an atomic string). The server announces the hint only; it does not reject smaller deposits unless you set `EnforceMinDeposit: true`.

## Run

```bash
cp .env-example .env
# fill in EVM_ADDRESS (the receiver) and FACILITATOR_URL

go run .
```

The server listens on `http://localhost:4021` and exposes `GET /weather`. Pair with `examples/go/clients/batch-settlement` and `examples/go/facilitator/batch-settlement`.

## Environment

| Variable                              | Required | Description |
|---------------------------------------|----------|-------------|
| `EVM_ADDRESS`                         | yes      | `payTo` address (channel receiver) |
| `FACILITATOR_URL`                     | yes      | Batch-settlement facilitator endpoint (e.g. `http://localhost:4022`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no       | Self-managed authorizer key. **Recommended** — channels survive facilitator changes when you control this key. Omit to delegate to the facilitator's advertised authorizer (existing channels must be drained before switching facilitators). |
| `STORAGE_DIR`                         | no       | If set, persists channel sessions under `${STORAGE_DIR}/server/` |
| `DEFERRED_WITHDRAW_DELAY_SECONDS`     | no       | Channel `withdrawDelay`; defaults to `86400` (1 day) |

## Auto-settlement

The example wires up a `ChannelManager` with simple local-demo triggers:

- **Claim** every 60 s.
- **Settle** every 120 s (sweeps claimed funds to `payTo`).
- **Refund** channels idle for 180 s (cooperative — claims first, then refunds the unclaimed remainder to the payer).

For production, choose a `withdrawDelay` greater than your claim cadence plus an operational safety margin.
