---
'@x402/paywall': patch
---

decimals.ts now only lists EVM networks whose default stablecoin is not 6 decimals, so new 6-decimal chains in DEFAULT_STABLECOINS no longer need a paywall regen for amount display
