---
"@x402/axios": patch
---

Fixed `onPaymentResponse` hooks (and hook-driven recovery) being skipped when the paid request returns an HTTP status that Axios rejects, such as 400 or 500. The hooks now run as they do in `@x402/fetch`, and the request still rejects with the original Axios error.
