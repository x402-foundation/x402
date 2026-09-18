---
'@x402/bsv': minor
---

Add `@x402/bsv` — BSV (Bitcoin SV) mechanism for the `exact` scheme. Implements BRC-121/BRC-29 native satoshi payments: the client's BRC-100 wallet creates a fully-funded BEEF transaction paying a BRC-42-derived key, and the recipient-wallet facilitator settles via `internalizeAction` with replay detection. Networks `bsv:mainnet` and `bsv:testnet`. Includes `createWhatsOnChainMoneyParser` for USD-denominated prices via the WhatsOnChain exchange-rate feed.
