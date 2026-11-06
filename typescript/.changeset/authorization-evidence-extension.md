---
"@x402/extensions": minor
---

Add the `authorization-evidence` resource-server extension: pre-payment verification of an operator-signed spend mandate through a pluggable External Verifier Contract v1 subprocess. Declaring the extension on a route makes evidence mandatory there; the `onBeforeVerify` hook denies the payment before facilitator verification when evidence is missing, invalid, replayed, or the verifier misbehaves in any way (fail-closed). Ships a client extension that echoes the server's signed challenge and attaches the presentation.
