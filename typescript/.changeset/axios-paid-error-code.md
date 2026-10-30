---
"@x402/axios": patch
---

Fixed paid Axios follow-up rejections to use `ERR_BAD_REQUEST` for HTTP 4xx and `ERR_BAD_RESPONSE` for HTTP 5xx, matching Axios settle, after `onPaymentResponse` runs.
