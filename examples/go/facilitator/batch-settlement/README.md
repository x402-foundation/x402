# Batch-Settlement Facilitator (Go)

Standalone HTTP facilitator for the **batch-settlement** scheme on Base Sepolia and/or Solana Devnet. Exposes the standard x402 endpoints:

- `GET /supported`
- `POST /verify`
- `POST /settle`

For EVM, the facilitator wallet submits onchain `deposit`, `claimWithSignature`, `settle`, and `refundWithSignature`. An optional `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` advertises `extra.receiverAuthorizer` in `/supported`.

For SVM, the facilitator broadcasts channel opens and redemptions, keeps shared in-memory channel storage, and runs `BatchSvmRentCleanupManager` so abandoned channels are sealed and rent is reclaimed.

## Run

```bash
cp .env-example .env
# fill in at least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY

go run .
```

Listens on `http://localhost:4022` by default (`PORT` overrides). Env keys match `examples/typescript/facilitator/batch-settlement/.env-local`.

## Facilitator-managed voucher custody (optional)

Spec v1.1 lets this facilitator own the voucher store, per-channel locks, and the claim/settle/refund schedule. Set `VOUCHER_STORE=true` (requires `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY`). Storage defaults to **in-memory**; set `VOUCHER_STORE_DIR` only when you need persistence across restarts. The example then registers a `VoucherStore`, advertises `extra.voucherManager: ["server", "facilitator"]` on `/supported`, and starts a `FacilitatorChannelManager` loop (same intervals as the [server example](../../servers/batch-settlement) demo).

Pair with the server example using `VOUCHER_STORE_MODE=facilitator` and **without** `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` on the server. This example does not authenticate `/settle` callers, so `/supported` advertises `delegatedRefund: false`; set `EVM_REFUND_AUTHORIZER_PRIVATE_KEY` on the server so it can consent to cooperative refunds itself.

```bash
# facilitator .env
EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY=0x...
VOUCHER_STORE=true
# VOUCHER_STORE_DIR=./voucher-store   # optional persistence
VOUCHER_STORE_WITHDRAW_DELAY_SECONDS=900

# server .env
VOUCHER_STORE_MODE=facilitator
EVM_REFUND_AUTHORIZER_PRIVATE_KEY=0x...
```

See the [scheme README](../../../../go/mechanisms/evm/batch-settlement/README.md#facilitator-managed-custody) for production notes (shared Redis locks, `delegatedRefund`, retention).

With `VOUCHER_STORE` enabled, claims carry their charge counts in the `m.x402ChargeCounts` field of a single ERC-8021 suffix. No builder code is needed: the example registers `BuilderCodeFacilitatorExtension` without one just to encode that suffix. Optional `FACILITATOR_BUILDER_CODE` adds a wallet code (`w`) to the same suffix. The manager `OnClaim` / `OnRefund` hooks parse the suffix from the transaction and join counts to channels by `channelId` (claim rows and `Claimed` logs); a row without a `Claimed` log is not attested.

## Environment

| Variable | Description |
|----------|-------------|
| `EVM_PRIVATE_KEY` | Facilitator wallet for Base Sepolia (optional if `SVM_PRIVATE_KEY` is set) |
| `SVM_PRIVATE_KEY` | Base58 Solana devnet key (optional if `EVM_PRIVATE_KEY` is set) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | Optional dedicated EVM authorizer key. Required when `VOUCHER_STORE=true`. |
| `EVM_RPC_URL` | Default `https://sepolia.base.org` |
| `SVM_RPC_URL` | Solana RPC (default devnet public endpoint when unset) |
| `SVM_ARCHIVE_RPC_URL` | Optional full-history RPC that recovers the receiver-authorizer binding after a restart |
| `RENT_CLEANUP_INTERVAL_SECS` | SVM rent cleanup tick interval (default `30`) |
| `RENT_CLEANUP_ABANDON_GRACE_SECS` | SVM abandon grace after voucher expiry (default `120`) |
| `PORT` | Listen port (default `4022`) |
| `VOUCHER_STORE` | Set to `true` / `1` / `yes` to enable facilitator-managed voucher custody (EVM) |
| `VOUCHER_STORE_DIR` | Optional file-backed voucher store directory (in-memory when unset) |
| `VOUCHER_STORE_WITHDRAW_DELAY_SECONDS` | Withdraw delay advertised in `/supported` (default `900`) |
| `FACILITATOR_BUILDER_CODE` | Optional ERC-8021 builder code appended on scheduled claims (EVM) |

`GET /supported` includes `extra.receiverAuthorizer` when `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` is set. With `VOUCHER_STORE=true`, it also includes `voucherManager: ["server", "facilitator"]` and `withdrawDelay`.
