---
"@x402/svm": patch
---

SVM upto delegated claim settle now returns `invalid_upto_svm_delegated_auth_store` when the identity store Get fails, instead of collapsing that outage into unauthenticated.
