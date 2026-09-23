# Batch-Settlement Hedera Facilitator Example

Hedera (`hedera:testnet`) counterpart of the EVM `batch-settlement` example in `../batch-settlement`. Uses `@x402/hedera/batch-settlement`: HTS USDC escrow, raw ED25519/ECDSA account signatures verified through the Hedera Account Service, and HAPI contract calls paid by the facilitator.

See the [scheme specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_hedera.md) and the [scheme README](../../../../typescript/packages/mechanisms/hedera/src/batch-settlement/README.md).

## Setup

```bash
cp .env-local .env   # fill in the Hedera account ids / keys
cd ../../ && pnpm install && pnpm build && cd facilitator/batch-settlement-hedera
pnpm dev
```

Testnet accounts and HBAR: https://portal.hedera.com. Testnet USDC (`0.0.429274`): https://faucet.circle.com (the account must be associated with the token first).

## Roles

| Env var                                    | Role                                                                                               |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| `HEDERA_ACCOUNT_ID` / `HEDERA_PRIVATE_KEY` | Operator: pays gas and submits `deposit` / `claimWithSignature` / `settle` / `refundWithSignature` |
| `HEDERA_RECEIVER_AUTHORIZER_*` (optional)  | Signs `ClaimBatch` / `Refund` digests; advertised as `receiverAuthorizer` in `/supported`          |

> A facilitator that advertises a `receiverAuthorizer` MUST authenticate cooperative refund requests. This example does not, so it is for local testing only.

Endpoints: `POST /verify`, `POST /settle`, `GET /supported` (default port 4022).

## Testnet contracts

Escrow [`0.0.10463847`](https://hashscan.io/testnet/contract/0.0.10463847), collector [`0.0.10463851`](https://hashscan.io/testnet/contract/0.0.10463851) (both Sourcify verified); the SDK uses them by default for `hedera:testnet`.
