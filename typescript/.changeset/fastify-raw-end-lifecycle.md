---
"@x402/fastify": patch
---

Fixed protected Fastify routes hanging after buffered `reply.raw.end()` calls by resuming the response lifecycle.
