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

## Environment

| Variable | Description |
|----------|-------------|
| `EVM_PRIVATE_KEY` | Facilitator wallet for Base Sepolia (optional if `SVM_PRIVATE_KEY` is set) |
| `SVM_PRIVATE_KEY` | Base58 Solana devnet key (optional if `EVM_PRIVATE_KEY` is set) |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | Optional EVM receiver authorizer for delegated claim/refund |
| `EVM_RPC_URL` | Default `https://sepolia.base.org` |
| `SVM_RPC_URL` | Solana RPC (default devnet public endpoint when unset) |
| `SVM_ARCHIVE_RPC_URL` | Optional full-history RPC that recovers the receiver-authorizer binding after a restart |
| `RENT_CLEANUP_INTERVAL_SECS` | SVM rent cleanup tick interval (default `30`) |
| `RENT_CLEANUP_ABANDON_GRACE_SECS` | SVM abandon grace after voucher expiry (default `120`) |
| `PORT` | Listen port (default `4022`) |
