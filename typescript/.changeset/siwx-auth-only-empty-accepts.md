---
"@x402/core": patch
---

`PaymentRequiredV2Schema` now accepts an empty `accepts` array when the 402 declares the `sign-in-with-x` extension, so clients can parse the responses of auth-only routes. Without that extension, an empty `accepts` is still rejected.
