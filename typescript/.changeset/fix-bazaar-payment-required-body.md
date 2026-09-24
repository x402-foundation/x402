---
"@x402/core": patch
---

Fix v2 `PaymentRequired` parsing to preserve `extensions` (including `bazaar`) from the 402 JSON body when the `PAYMENT-REQUIRED` header is missing or omits them.
