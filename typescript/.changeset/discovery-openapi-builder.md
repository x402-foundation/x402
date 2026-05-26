---
"@x402/extensions": minor
---

Add `discovery`, a pure function that converts an x402 `RoutesConfig` into an AgentCash-compatible OpenAPI 3.1 document for hosting at `/openapi.json`. Derives paths, parameters, request bodies, payment info (`x-payment-info`), and SIWX security from the same routes map and bazaar declarations the server already has — no core changes, no new hooks. Exported alongside `DiscoveryOptionsSchema` and `OpenAPIDocumentSchema` Zod schemas for runtime validation.
