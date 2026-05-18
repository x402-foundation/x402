---
"@x402/paywall": minor
---

Add `faucetUrls?: Record<network, string>` to `PaywallConfig` plus a curated testnet faucet map in `@x402/paywall`. Server overrides win over the curated map; unmapped chains render "No faucet configured." rather than a fallback link.
