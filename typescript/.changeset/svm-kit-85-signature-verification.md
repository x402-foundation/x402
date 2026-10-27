---
"@x402/svm": patch
---

Import exact client public keys as extractable before Kit's `verifySignature`. Kit 8.5 reads those bytes to reject small-order points and throws otherwise, so every client signature was reported as `invalid_exact_svm_payload_signature_invalid` and every exact payment was refused.
