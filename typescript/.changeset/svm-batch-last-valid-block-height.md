---
"@x402/svm": patch
---

SVM batch-settlement treats `extra.lastValidBlockHeight` as a per-`PaymentRequired` transaction-construction hint, as `exact` and `upto` do. The batch client already read it next to `extra.recentBlockhash`, but the server's requirements matching and the facilitator's `paymentPayload.accepted` check compared it, so a server that refreshed the pair for each challenge was refused. `BatchExtra` and `isBatchExtra` now include the field as a decimal string.
