---
"@x402/core": patch
"@x402/mcp": patch
---

Fixed `skipHandler` skipping settlement on payment flows that settle before the handler, in the HTTP resource server and the MCP payment wrapper. A skipped request now settles like a normal one: the before-handler settle runs first and is passed to the after-handler settle. Previously an `upfront` skip response was released with no settlement, and on `escrow` (for example auth-capture) the before-handler `authorize` was skipped, so `captureMode: "sync"` failed and `"deferred"` left no authorized-payment record to capture later.
