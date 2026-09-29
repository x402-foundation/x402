---
"@x402/svm": patch
---

`findPaymentChannelPda` now caches derived channel addresses (bounded LRU, 4,096 entries). The batch-settlement server and facilitator derive the channel PDA on every request; repeat requests on a channel now skip the SHA-256 + off-curve bump search.
