---
"@x402/core": minor
---

Add `onVerifiedPaymentCompleted`, a resource-server hook that fires once when the handler succeeds in a flow that settles only before it (`upfront`). Until now no hook ran on that path, so a store could not tell a served request from a process that died inside the handler. The context carries the before-handler settle result and the transport context with the response.
