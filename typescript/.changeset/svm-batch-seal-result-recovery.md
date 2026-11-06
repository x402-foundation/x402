---
"@x402/svm": patch
---

The SVM batch-settlement facilitator now recovers a confirmed `seal` or cooperative `refund` whose sealed `distribute` deallocated the channel. The close's response is stored with its signature and receiver before the transaction is sent. A retry finishes from that record instead of re-reading the channel, so `onDistributionConfirmed` still runs once. A failure to record the outcome after confirmation (the sealed state not yet visible, completion, or the result write) is now `settlement_pending` carrying the signature, instead of a failure with an empty `transaction`. Retries naming a different `payTo` or `asset` than the stored close are rejected with `invalid_batch_settlement_svm_channel_state`.
