---
"@x402/axios": patch
---

Re-read the payment requirements from the 402 returned by an `onPaymentRequired` hook retry, so the payload is created from the offer the server just sent rather than the superseded one, and read that retry response through the case-insensitive header getter. A retry 402 whose body cannot be parsed now rejects with the parse failure attached as `cause`.