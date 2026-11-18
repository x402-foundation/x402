# Site e2e tests

Real end-to-end tests for the testnet `/protected/{evm,svm}/{exact,upto}...` routes
under `typescript/site`. Each test pays for a route using the real x402 client SDKs
(`@x402/fetch` plus the EVM/SVM `exact`/`upto` client schemes) against the site's own
Next.js server, spawned by the suite itself — no mocking, no separately-running dev
server required.

## Run

```bash
pnpm test:e2e
```

## Setup

Add to `typescript/site/.env.local` (gitignored):

```bash
# Base Sepolia. Needs ETH (gas) and USDC, and must already have approved the
# canonical Permit2 contract to spend that USDC — /exact/permit2 and
# /upto/permit2 (no-extension) require pre-approval and don't offer gasless
# approval themselves.
CLIENT_EVM_PRIVATE_KEY=0x...

# Solana devnet. Needs SOL (fees/rent) and devnet USDC. Must be a *different* key
# from FACILITATOR_SVM_PRIVATE_KEY (in .env) — the exact SVM scheme rejects a
# payment where the fee payer and the payer are the same account.
CLIENT_SVM_PRIVATE_KEY=...

# Optional; defaults to the public Base Sepolia RPC. Enables the gasless EIP-2612
# permit path the /permit2/eip2612 routes are meant to exercise.
CLIENT_EVM_RPC_URL=
```

This app's own `RESOURCE_*`/`FACILITATOR_*` vars (already required to run the site at
all — see `typescript/site/.env`) are also required, since the spawned test server is
the real app.

## Wallet safety

Every test pays a small (testnet) amount, so repeated runs drain these wallets over
time — same caveat as [`e2e/README.md`](../../../../e2e/README.md#wallet-safety-warning).
Use dedicated testnet-only wallets; top them up from a faucet as needed.

## Why not `e2e/`?

The repo's root [`e2e/`](../../../../e2e/) suite is a catalog-driven harness for
testing SDK correctness generically across many client/server/facilitator/network
combinations. These tests instead validate one specific deployed app's specific
routes (its JSON 402/200 response shapes, its `upto` settlement override, etc.), so
they live next to the code they test rather than in that generic harness.
