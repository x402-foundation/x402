---
"@x402/svm": patch
---

Report cooperative seal and refund payouts to the receiver through `onDistributionConfirmed`, once per close, and return `settlement_pending` when the callback fails so a retry can record the payout without rebroadcasting.
