---
"@x402/axios": patch
"@x402/core": patch
"@x402/express": patch
"@x402/fastify": patch
"@x402/fetch": patch
"@x402/hono": patch
"@x402/next": patch
"@x402/paywall": patch
---

Fixed TypeScript projects that use `moduleResolution` `"node"` so they load declarations for the HTTP packages. The top-level `types` entry pointed at `dist/index.d.ts`, which the build does not emit. `@x402/core` subpaths were listed only in `exports`, which that mode does not read, so those declarations could not resolve `@x402/core/client`, `@x402/core/server`, `@x402/core/http`, or `@x402/core/types`. `typesVersions` now maps each public subpath to its shipped `dist/cjs` declaration.
