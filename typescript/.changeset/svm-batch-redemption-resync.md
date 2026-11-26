---
"@x402/svm": patch
---

SVM batch-settlement no longer resubmits a claim, distribute or seal forever when the transaction confirmed but its response was lost. The facilitator attaches `extra.channelStates[]` to a claim or distribute rejected with `cumulative_amount_mismatch` because it is already applied, to a seal rejected with `close_state` because the channel is no longer `Closing` or the voucher is below `settled`, and to a successful distribute. `BatchChannelManager` adopts those states when they name exactly the submitted channels, resyncing claimed channels, re-claiming the rest once, and recording paid-out or sealed channels without counting them as new claims or seals.
