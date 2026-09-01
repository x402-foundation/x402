---
"@x402/svm": major
---

Support Solana transaction version 1 (SIMD-0296 / SIMD-0385) in the `exact` scheme facilitator.

The static verification path accepts version 1 transactions, reading the compute unit limit, loaded accounts data size limit, and priority fee from `message.config` instead of ComputeBudget instructions (`computeUnitLimit` and `loadedAccountsDataSizeLimit` are required — a version 1 transaction that omits either is budgeted zero and cannot execute), with the total-lamport priority fee normalized against the operator's per-compute-unit cap. Smart wallet verification enforces the same config caps and rejects ComputeBudget instructions inside version 1 transactions. Post-settlement TOCTOU verification now fetches transactions with `maxSupportedTransactionVersion: 1`. The legacy x402 v1 wire scheme and the `upto` open-transaction verifier reject version 1 transactions explicitly (`unsupported_transaction_version`) instead of letting instruction-scanning checks pass vacuously.

BREAKING: the `@solana/kit` peer dependency floor is now `>=8.0.0` (required to decode version 1 transactions), and `@solana-program/compute-budget` / `token` / `token-2022` moved to their kit-v8-compatible releases.
