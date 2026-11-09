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

## Facilitator-managed custody (optional)

Set `VOUCHER_STORE_MODE=facilitator` and run a facilitator with `VOUCHER_STORE=true` (see the [facilitator example](../../facilitator/batch-settlement)). The server becomes a pass-through: every voucher goes through facilitator `/verify` and `/settle`; the facilitator `ChannelManager` owns claim/settle/refund scheduling. Do not set `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` in this mode.

## Environment

| Variable | Required | Description |
|----------|----------|-------------|
| `EVM_ADDRESS` | one of EVM/SVM | EVM `payTo` address (channel receiver) |
| `SVM_ADDRESS` | one of EVM/SVM | Solana `payTo` |
| `FACILITATOR_URL` | yes | Batch-settlement facilitator endpoint (e.g. `http://localhost:4022`) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Self-managed authorizer key. **Recommended** — channels survive facilitator changes when you control this key. Omit to delegate to the facilitator's advertised authorizer. Incompatible with `VOUCHER_STORE_MODE=facilitator`. |
| `EVM_REFUND_AUTHORIZER_PRIVATE_KEY` | no | Refund consent key for facilitator-managed mode (402 `extra.refundAuthorizer`); omit to rely on the facilitator's `delegatedRefund: true` (the 402 then omits `extra.refundAuthorizer`) |
| `VOUCHER_STORE_MODE` | no | `facilitator` for facilitator-managed custody; default is self-managed |
| `SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | when `SVM_ADDRESS` is set | Base58 receiver authorizer |
| `SVM_OPERATOR_PRIVATE_KEY` | no | SVM operator for server-signed metering (base58) |
| `SVM_RPC_URL` | no | Solana RPC for redemption worker |
| `STORAGE_DIR` | no | Self-managed: session store. Facilitator-managed: post-settle replica only |
| `DEFERRED_WITHDRAW_DELAY_SECONDS` | no | Self-managed channel `withdrawDelay`; defaults to `86400` (1 day) |

## Auto-settlement

The example wires up a `ChannelManager` with simple local-demo triggers:

- **Claim** every 60 s.
- **Settle** every 120 s (sweeps claimed funds to `payTo`).
- **Refund** channels idle for 180 s (cooperative — claims first, then refunds the unclaimed remainder to the payer).

For production, choose a `withdrawDelay` greater than your claim cadence plus an operational safety margin.
