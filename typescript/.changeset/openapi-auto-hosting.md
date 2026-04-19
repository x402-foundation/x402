---
"@x402/core": minor
"@x402/express": minor
"@x402/hono": minor
"@x402/fastify": minor
"@x402/next": minor
---

Auto-serve OpenAPI spec at `/openapi.json` for x402 resource servers. Adds `@x402/core/openapi` module that generates an OpenAPI 3.1.0 spec from route config with `x-payment-info` extensions. All framework middlewares now register the endpoint automatically (opt-out with `openAPIOptions: false`).
