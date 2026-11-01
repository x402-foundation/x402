---
"@x402/svm": minor
---

The SVM batch-settlement facilitator builds its redemption transactions (claim, settle, seal, refund, idle close, rent cleanup) as transaction v1, with a compute budget sized for the batch and a 4 MiB loaded-account-data budget, and advertises the capacity that gives in `/supported` as `extra.maxClaimChannels` (18) and `extra.maxSettleChannels` (13). Add `facilitatorTransactionVersion` (0 or 1) to `BatchSvmFacilitatorConfig` and `BatchSvmRentCleanupManagerConfig` to choose the message version of the transactions the facilitator builds itself; `0` keeps version 0, which advertises four of each. Client-built versions are unaffected. Unset keeps v1; any other value throws.

A claim or settle request longer than the advertised capacity is rejected with `invalid_batch_settlement_svm_payload_type`, and a batch that does not fit one transaction fails before anything is sent. The server copies both fields into its requirements and sizes its claim and settle batches by them (four when absent); `maxChannelsPerBatch` still narrows them.
