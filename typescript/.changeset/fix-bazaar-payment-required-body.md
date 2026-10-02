---
"@x402/core": patch
---

Fix v2 `PaymentRequired` parsing so `extensions` (including `bazaar`) from the 402 JSON body are deep-merged under the `PAYMENT-REQUIRED` header. The header wins per field, including nested objects; body-only fields are kept when the header is missing or its namespace is only partial. Arrays are taken from the header when present.
