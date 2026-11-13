---
"@x402/fetch": patch
---

Reject already-attempted requests before signing a payment, so no authorization is created or spend hook fired for a request that will be refused.
