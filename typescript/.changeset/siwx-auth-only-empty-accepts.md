---
"@x402/core": patch
---

`PaymentRequiredV2Schema` now accepts an empty `accepts` array, as the v2 spec allows, so clients can parse the 402 of auth-only routes (for example sign-in-with-x). Creating a payment from a 402 with nothing to pay still fails with a clear error.
