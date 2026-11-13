---
"@x402/core": minor
---

Add `reconcilePaymentPayload` to `x402Client` and `x402HTTPClient`, backed by an optional `reconcilePaymentPayload` on `SchemeNetworkClient`, so transports can ask whether a payload they already sent has settled before signing another.
