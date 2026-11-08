---
"@x402/axios": patch
"@x402/express": patch
"@x402/fastify": patch
"@x402/fetch": patch
"@x402/hono": patch
"@x402/next": patch
"@x402/paywall": patch
---

Fixed TypeScript projects that use `moduleResolution` `"node"` so they load declarations for the HTTP packages. The top-level `types` entry pointed at `dist/index.d.ts`, which the build does not emit.
