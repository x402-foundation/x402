---
"@x402/core": patch
"@x402/express": patch
---

Include the rejection reason (`error`) in the JSON 402 body for non-browser clients when no custom unpaid response is provided, and return `{ error: "settlement_failed" }` instead of `{}` from the Express adapter's settlement catch-all, so agent clients that read the body instead of the PAYMENT-REQUIRED header can tell why a payment was rejected.
