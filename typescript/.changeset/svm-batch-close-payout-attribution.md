---
"@x402/svm": patch
---

SVM batch-settlement now attributes the payout, refund and closed deposit of a seal or cooperative refund from the confirmed close transaction instead of the channel read taken before it was sent. A sweep or top-up that lands before the close no longer overstates the merchant payout or the refund in the response, the stored result or `onDistributionConfirmed`. A close whose transaction metadata is not yet visible answers `settlement_pending` and is attributed on retry, and one that cannot be attributed fails with `payout_attribution_ambiguous`. `BatchSvmScheme` now requires `getConfirmedTransaction` on the facilitator signer and throws at construction without it; `toFacilitatorSvmSigner` already provides it.
