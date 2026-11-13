---
"@x402/fastify": patch
---

Moved Fastify payment processing to preValidation so payment hooks and dynamic pricing can read the parsed request body while retaining payment headers before schema validation.
