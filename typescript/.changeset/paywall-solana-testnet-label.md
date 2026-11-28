---
"@x402/paywall": patch
---

The paywall no longer labels Solana testnet as "Solana Mainnet". `getNetworkDisplayName` now returns "Solana Testnet" for it, and `isTestnetNetwork` treats it as a testnet, so the faucet hint shows up.
