# Batch-Settlement Hedera Server Example

Hedera (`hedera:testnet`) counterpart of the EVM `batch-settlement` example in `../batch-settlement`. Uses `@x402/hedera/batch-settlement`: HTS USDC escrow, raw ED25519/ECDSA account signatures verified through the Hedera Account Service, and HAPI contract calls paid by the facilitator.

See the [scheme specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_hedera.md) and the [scheme README](../../../../typescript/packages/mechanisms/hedera/src/batch-settlement/README.md).

## Setup

```bash
cp .env-local .env   # fill in the Hedera account ids / keys
cd ../../ && pnpm install && pnpm build && cd servers/batch-settlement-hedera
pnpm dev
```

Testnet accounts and HBAR: https://portal.hedera.com. Testnet USDC (`0.0.429274`): https://faucet.circle.com (the account must be associated with the token first).

## Notes

- `HEDERA_ACCOUNT_ID` is the `payTo` account; it must be associated with USDC to receive settlements.
- Provide `HEDERA_RECEIVER_AUTHORIZER_*` to self-manage claim/refund authorization (recommended); otherwise the facilitator's advertised `receiverAuthorizer` is used and the facilitator must be running with one configured.
- The channel manager claims every 60 s, settles every 120 s and refunds channels idle for 3 minutes.

## Testnet contracts

Escrow [`0.0.10463847`](https://hashscan.io/testnet/contract/0.0.10463847), collector [`0.0.10463851`](https://hashscan.io/testnet/contract/0.0.10463851) (both Sourcify verified); the SDK uses them by default for `hedera:testnet`.
