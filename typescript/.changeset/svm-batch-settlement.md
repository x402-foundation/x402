---
"@x402/svm": minor
---

Added an SVM `batch-settlement` implementation for long-lived payment channels and cumulative offchain vouchers. Reuses the `upto` payment-channel primitives, adds server-owned voucher reservations and post-handler commits, batched claim/distribution operations, payer-forced close and grace-period finalization, and onchain facilitator recovery. Ships dedicated client, server, and facilitator entry points.
