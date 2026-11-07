---
"@x402/core": patch
---

Export `prepareHttpServer` and `PreparedHttpServer` from `@x402/core/server` and `@x402/core/http`. The helper owns the facilitator initialization the Express, Fastify, Hono, and Next middlewares previously duplicated: the eager `initialize()` promise shared with the first protected request, the retry after a retryable failure, and the fatal startup exit. Paywall registration is unchanged. The four adapters now share it, and their behavior is unchanged.
