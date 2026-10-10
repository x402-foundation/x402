---
"@x402/express": patch
---

Fixed `@x402/express` JSON-encoding a payment-error body when the response declares `text/plain`. A string body with that content type is now sent as text, preserving newlines. JSON object bodies are unchanged.
