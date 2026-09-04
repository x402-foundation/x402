---
"@x402/axios": minor
---

Added an optional caller-owned `validatePaidResponse` hook to `wrapAxiosWithPayment` and `wrapAxiosWithPaymentFromConfig`. It runs after payment-result processing on ordinary and recovery paid responses, gives the validator a detached view, preserves the original Axios response and pre-validator `PAYMENT-RESPONSE` evidence, fail-closes on non-cloneable bodies, and never retries or repays. Behavior is unchanged when the option is omitted.
