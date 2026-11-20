---
"@x402/extensions": patch
---

Apply the facilitator client's `timeoutMs` to `withBazaar` `listResources()` and `search()`, so an unresponsive facilitator no longer leaves discovery calls pending indefinitely.
