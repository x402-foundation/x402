---
"@x402/express": patch
"@x402/axios": patch
"@x402/fetch": patch
"@x402/hono": patch
"@x402/fastify": patch
"@x402/next": patch
"@x402/paywall": patch
---

Fix top-level `types` field in package.json: it pointed to `./dist/index.d.ts`, which is not emitted to the published tarball. Point it at the CJS declaration file (`./dist/cjs/index.d.ts`, or `index.d.cts` where applicable) that the package actually ships, matching the `require` condition's `types` entry.
