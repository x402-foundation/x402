# Batch-Settlement Hedera Client Example

Hedera (`hedera:testnet`) counterpart of the EVM `batch-settlement` example in `../batch-settlement`. Uses `@x402/hedera/batch-settlement`: HTS USDC escrow, raw ED25519/ECDSA account signatures verified through the Hedera Account Service, and HAPI contract calls paid by the facilitator.

See the [scheme specification](../../../../specs/schemes/batch-settlement/scheme_batch_settlement_hedera.md) and the [scheme README](../../../../typescript/packages/mechanisms/hedera/src/batch-settlement/README.md).

## Setup

```bash
cp .env-local .env   # fill in the Hedera account ids / keys
cd ../../ && pnpm install && pnpm build && cd clients/batch-settlement-hedera
pnpm dev
```

Testnet accounts and HBAR: https://portal.hedera.com. Testnet USDC (`0.0.429274`): https://faucet.circle.com (the account must be associated with the token first).

## One-time allowance

Before the first paid request, grant the deposit collector an HTS allowance for USDC (signed with the payer key, costs a small HBAR fee):

```bash
pnpm approve          # ALLOWANCE_AMOUNT=max by default
```

## Run

```bash
NUMBER_OF_REQUESTS=5 pnpm dev
REFUND_AFTER_REQUESTS=true pnpm dev   # request a cooperative refund of the remaining balance at the end
```

The first request deposits into the channel (one facilitator-submitted transaction); subsequent requests are voucher-only (no onchain transaction). Set `HEDERA_VOUCHER_SIGNER_*` to sign vouchers with a separate account (committed as `payerAuthorizer`).

## Testnet contracts

Escrow [`0.0.10463847`](https://hashscan.io/testnet/contract/0.0.10463847), collector [`0.0.10463851`](https://hashscan.io/testnet/contract/0.0.10463851) (both Sourcify verified); the SDK uses them by default for `hedera:testnet`.
