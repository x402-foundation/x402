---
"@x402/core": patch
---

Fixed `x402ResourceServer.buildPaymentRequirements()` silently returning an empty array and logging a `console.warn` when no scheme server is registered for the requested scheme/network. It now throws, matching the adjacent guard that already throws when the facilitator does not support the scheme/network. An unregistered scheme is a server misconfiguration, and the empty array previously surfaced downstream as a 402 response with no `accepts` entries instead of a clear error.
