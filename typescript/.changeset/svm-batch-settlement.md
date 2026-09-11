---
"@x402/svm": minor
---

Added an SVM `batch-settlement` implementation for long-lived payment channels and cumulative offchain vouchers. Reuses the `upto` payment-channel primitives, adds client-signed vouchers and concurrent server-signed metering with itemized receipts, batched claim/distribution operations, payer-forced close and grace-period finalization, and onchain facilitator recovery. Ships dedicated client, server, and facilitator entry points.
