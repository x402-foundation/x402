---
"@x402/paywall": patch
---

The Solana paywall now asks for a version-1 transaction only when the connected wallet lists `1` in the `supportedTransactionVersions` of its `solana:signTransaction` feature. Other wallets, including those that do not declare their versions, keep paying with version 0 when the facilitator advertises `extra.transactionVersions` `[0, 1]`. The paywall now depends on `@solana/kit` 8, which encodes and decodes version-1 transactions, and on `@solana/wallet-standard-features` 1.5, which adds version `1` to `SolanaTransactionVersion`. The regenerated paywall templates ship the change to the Python and Go SDKs.
