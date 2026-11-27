---
"@x402/fastify": patch
---

When settlement fails after the route handler ran, the 402 (or 502) response no longer carries the headers the handler set, such as `Set-Cookie` or `Content-Disposition`. Headers set before the handler (for example CORS) are kept.
