---
"@x402/svm": patch
---

Reject reuse of a server-mode batch-settlement request id with a different ceiling as `invalid_batch_settlement_svm_operation_ceiling_changed` instead of `transaction_failed`, so servers can tell it apart from other failures and treat it like `duplicate_settlement`. `MemoryBatchOperationStore.reserve` now returns the existing operation instead of throwing; custom `BatchOperationStore` implementations should do the same.
