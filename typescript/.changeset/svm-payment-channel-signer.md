---
"@x402/svm": patch
---

Batch settlement validates payment-channel signer capabilities at construction and records confirmation slots via a signer proxy, removing scattered runtime checks and the `submissionSigner()` wrapper.
