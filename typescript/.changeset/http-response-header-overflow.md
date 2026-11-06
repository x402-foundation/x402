---
"@x402/core": patch
"@x402/fetch": patch
"@x402/axios": patch
---

Added actionable response-header overflow errors for Fetch and Axios, identifying oversized PAYMENT-REQUIRED metadata as a possible cause while preserving the transport error details.
