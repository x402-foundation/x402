---
"@x402/svm": patch
---

SVM transaction v1 follow-ups:

- `toFacilitatorSvmSigner().getConfirmedTransaction` / `getConfirmedTransactionInnerInstructions` and `channelHistoryReads().getTransaction` request `maxSupportedTransactionVersion: 1`. With `0`, the RPC refused every v1 transaction, so a v1 batch-settlement distribution stayed `settlement_pending`, the smart-wallet post-settle check fell back to the balance difference, and the receiver-binding history reader could not read a v1 open.
- The x402 v1 exact facilitator (`ExactSvmSchemeV1`) takes `transactionVersions` like the v2 one, and `registerExactSvmScheme` accepts `transactionVersions` and applies it to both.
- The open/settle/distribute readiness simulation of the upto and batch-settlement facilitators gates on their configured `transactionVersions`.
- The batch-settlement channel manager clamps the advertised `maxClaimChannels` / `maxSettleChannels` to the protocol maximum (18 / 13).

Compatibility note: the batch-settlement facilitator requires `paymentPayload.accepted` to equal `paymentRequirements` (spec §4.5), ignoring only the dynamic `extra` fields the server regenerates per `PaymentRequired`. This is stricter than core's `paymentRequirementsMatchAccepted`, which allows extra fields in `accepted.extra`: a client that adds its own metadata there is rejected with `invalid_payment_requirements`.
