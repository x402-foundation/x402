---
"@x402/extensions": patch
---

Apply the facilitator client's `timeoutMs` to `withBazaar` `listResources()` and `search()`. An unresponsive facilitator now rejects with `FacilitatorTimeoutError` instead of leaving discovery calls pending indefinitely.
