---
"@x402/core": patch
"@x402/express": patch
"@x402/fastify": patch
"@x402/hono": patch
"@x402/next": patch
---

Fix cold-start discovery probe timeouts on serverless/edge runtimes. Decouples facilitator init from 402 generation: probes no longer block on the facilitator round-trip; init is awaited only when a payment header is present.
