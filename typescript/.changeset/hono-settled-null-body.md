---
"@x402/hono": patch
---

Fixed settled null-body responses (204, 205, 304) returning 402 instead of preserving their status and settlement headers.
