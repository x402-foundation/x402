---
"@x402/fetch": minor
---

Hold the signed payment per purchase and re-present it on retry instead of signing a new one when the paid attempt fails ambiguously (timeout, 5xx, or a new 402 after payment). A fresh payment is signed only after a definite settle failure, or after the authorization window closes and `reconcilePaymentPayload` confirms the payment never settled. When the outcome cannot be established the call throws the new `PaymentOutcomeUnknownError`.
