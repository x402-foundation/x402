---
"@x402/svm": patch
---

Fail SVM batch-settlement server verification closed when a store call fails before the request is reserved. Previously the `afterVerify` hook threw, core kept the facilitator's valid result, and the handler ran with no reservation or request-id fence.
