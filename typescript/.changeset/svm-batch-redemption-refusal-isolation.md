---
"@x402/svm": patch
---

Keep the batch-settlement redemption worker going when the facilitator refuses one channel. A thrown `SettleError` (such as an HTTP 403 from a facilitator policy hook) no longer ends the pass: a claim or distribute batch refused before broadcast is retried one channel at a time, so the other channels in it are still claimed and paid out, a channel still refused is submitted alone in later passes, and a refused `seal` no longer skips the rest of the pass. Failures that may still land (`settlement_pending`, `duplicate_settlement`, a response naming a transaction, or a transport error) leave the batch whole for the next pass. These failures are reported to `onError` and no longer reject `redeem()`.
