---
"@x402/aptos": patch
"@x402/axios": patch
"@x402/avm": patch
"@x402/canton": patch
"@x402/cardano": patch
"@x402/casper": patch
"@x402/concordium": patch
"@x402/core": patch
"@x402/evm": patch
"@x402/express": patch
"@x402/extensions": patch
"@x402/fastify": patch
"@x402/fetch": patch
"@x402/hedera": patch
"@x402/hono": patch
"@x402/keeta": patch
"@x402/near": patch
"@x402/next": patch
"@x402/paywall": patch
"@x402/stellar": patch
"@x402/svm": patch
"@x402/tvm": patch
"@x402/xrpl": patch
---

Fixed TypeScript projects using `moduleResolution` `"node"` so current packages expose declarations at their public entrypoints. HTTP package `types` fields now point to shipped CJS declarations, and `typesVersions` maps every current public subpath to its shipped CJS declaration. Modern `exports` resolution is unchanged; frozen legacy packages are not modified.
