---
"@x402/fetch": patch
---

Re-read the payment requirements from the 402 returned by an `onPaymentRequired` hook retry, so the payload is created from the offer the server just sent rather than the superseded one. A retry 402 whose body cannot be parsed now surfaces as an error with the parse failure attached as `cause`.