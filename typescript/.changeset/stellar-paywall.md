---
"@x402/paywall": minor
---

Add `@x402/paywall/stellar`: a Stellar paywall handler and browser bundle ported from `stellar/x402-stellar`. Connects Freighter, Hana, Klever and OneKey via Stellar Wallets Kit, signs the `exact` auth entry with `signAuthEntry`, reads USDC balances via Soroban simulation, and surfaces missing-trustline and wrong-network states. Amounts are formatted with Stellar's 7 decimals.
