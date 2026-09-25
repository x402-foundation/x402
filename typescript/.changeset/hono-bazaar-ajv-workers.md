---
"@x402/extensions": patch
---

Fix bazaar extension schema validation logging a misleading per-route "invalid bazaar extension" warning (plus an Ajv compile error) on JS runtimes that forbid dynamic code generation, such as Cloudflare Workers. `validateDiscoveryExtension` now reports this as `unavailable` rather than `valid: false`, and `validateBazaarRouteExtensions` (used by `@x402/hono`, `@x402/express`, `@x402/fastify`, and `@x402/next`) emits a single one-time notice and skips further schema checks instead of repeating the error for every gated route.
