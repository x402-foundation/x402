---
"@x402/svm": patch
---

Keep the batch-settlement redemption worker going when the facilitator refuses one channel. A facilitator answer that refuses a request, returned as `success: false` or thrown as a `SettleError` (such as an HTTP 403 from a facilitator policy hook), no longer ends the pass: a claim or distribute batch refused outright is retried one channel at a time, so the other channels in it are still claimed and paid out, a channel still refused is submitted alone in later passes, and a refused `seal` no longer skips the rest of the pass. Failures that may still land or pass on their own (`settlement_pending`, `duplicate_settlement`, a response naming a transaction, or a 5xx, 408, 425 or 429) are not split, and the same channels are sent together again on later passes until the facilitator answers for good. These answers are reported to `onError` and no longer reject `redeem()`; a request that gets no answer (a timeout or network error) still ends the pass as before.
