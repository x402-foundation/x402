# SVM Smart Wallet E2E Client

Exercises x402 SVM **Path 2** (simulation-based smart wallet verification) using a [Swig](https://build.onswig.com/) wallet via [`@swig-wallet/kit`](https://build.onswig.com/reference/typescript/kit).

Path 1 static validation rejects Swig-wrapped transactions (unknown program layout). With `enableSmartWalletVerification: true` on the facilitator, verification falls back to Path 2: simulate the transaction, inspect CPI inner instructions for `TransferChecked`, and match amount/mint/recipient.

## How it works

`CLIENT_SVM_PRIVATE_KEY` (passed as `SVM_PRIVATE_KEY`) is the Swig **authority** — the Ed25519 key that owns the root role. Before each endpoint, the e2e harness calls `scripts/swig-setup.ts` to ensure the Swig account exists, create ATAs if needed, and top up USDC when balance is below one payment (to 10× one payment). On first creation it writes `SWIG_ACCOUNT_ADDRESS` (and `SWIG_ID_BASE58` when generated) to `e2e/.env`. The client only builds and signs payment transactions.

## Requirements

- `SVM_PRIVATE_KEY` — Ed25519 authority (base58); e2e maps this from `CLIENT_SVM_PRIVATE_KEY`
- `SWIG_ACCOUNT_ADDRESS` — written to `e2e/.env` automatically on first Swig creation
- Devnet **SOL** on the authority key (~0.005 SOL for Swig creation; [Solana faucet](https://faucet.solana.com/))
- Devnet **USDC** on the authority key ([Circle faucet](https://faucet.circle.com/))
- `RESOURCE_SERVER_URL` / `ENDPOINT_PATH` — set by the e2e framework (target `/exact/svm`)

Optional:

- `SWIG_ID_BASE58` — fixed Swig id when creating a new account
- `SVM_RPC_URL` — custom RPC (also forwarded from the e2e network config)
- `SVM_USDC_MINT` — override devnet USDC mint for setup script

## Setup (manual)

From `e2e/` (same pattern as permit2):

```bash
pnpm swig:setup
```

First run writes `SWIG_ACCOUNT_ADDRESS` to `e2e/.env` automatically.

## Run

```bash
cd e2e
pnpm install
pnpm test --testnet --clients=svm-smart-wallet --servers=express --facilitators=typescript --endpoints=/exact/svm --min
```

The harness runs `swig-setup` automatically before each svm-smart-wallet endpoint when the Swig USDC balance is below one payment — no manual setup needed for `pnpm test`.

Use the **TypeScript** facilitator — it must register `ExactSvmScheme` with `enableSmartWalletVerification: true` (configured in `e2e/facilitators/typescript`).

Go and Python facilitators do not implement SVM Path 2 yet; tests against those facilitators will fail verification.
