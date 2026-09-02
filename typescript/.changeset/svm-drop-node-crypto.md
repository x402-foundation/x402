---
"@x402/svm": patch
---

Replace `node:crypto`/`Buffer` usage in `transactionMessageHash`, `getChannelDistributionHash`, and payment-channel account discovery with `@noble/hashes/sha256` and `@solana/kit`'s base64 codec. These SHA-256 call sites were only ever needed by facilitator-side code, but lived in modules also imported by `exact/client`/`upto/client`, pulling Node's `crypto` module (and `Buffer`) into browser bundles of any consumer that imports the SVM client and forcing a `crypto`/`buffer` polyfill (e.g. `vite-plugin-node-polyfills`). `@noble/hashes` is a pure-JS, dependency-free SHA-256 implementation that produces byte-identical digests and needs no platform crypto API or polyfill on any target (browser, Node, React Native).
