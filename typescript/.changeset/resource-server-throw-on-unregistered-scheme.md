---
"@x402/core": patch
---

`x402ResourceServer.buildPaymentRequirements()` now throws when no scheme server is registered for the requested scheme and network, instead of logging a `console.warn` and resolving with an empty array. It previously produced a 402 response carrying an empty `accepts` list, which is unusable to a client and gives no signal that the server is misconfigured. The new error matches the adjacent guard that already throws when the facilitator does not advertise the scheme and network.

This is a breaking change. A call that previously resolved with `[]` now rejects, so any resource server that reaches a priced route without a registered scheme server changes from answering 402 to surfacing an error. Callers must register a scheme server for every network they price a route on.
