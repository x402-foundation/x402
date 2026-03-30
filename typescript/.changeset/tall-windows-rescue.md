---
'@x402/fastify': patch
---

Applied monkey-patch on reply.raw write operations and buffered response to prevent content leak from direct raw writes bypassing Fastify's onSend lifecycle
