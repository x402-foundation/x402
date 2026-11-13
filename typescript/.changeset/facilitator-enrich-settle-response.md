---
"@x402/core": minor
---

Facilitator extensions can now add data to the settlement response: `FacilitatorExtension` gains an optional `enrichSettleResponse(context)` hook, which `x402Facilitator.settle()` calls for each registered extension after the `afterSettle` hooks. A defined return value is placed in `SettleResponse.extensions[key]`. A hook that throws is logged and skipped, so it never turns a completed settlement into an error, and the hook does not run when settlement itself throws.
