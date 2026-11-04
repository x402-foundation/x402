---
'@x402/evm': patch
---

Harden facilitator-managed batch settlement: managed EVM state parsing fails closed without releasing or corrupting facilitator admission state. Abandoned request contexts expire after the server's own `maxTimeoutSeconds` (minimum 5 seconds) plus a 10-second grace, malformed replica state is ignored, and refund enrichment failures retain the pending lock handle so `settlement_preflight_failed` cancellation can still release it. Self-managed batch settlement now also releases its admission lock on `settlement_preflight_failed`, so a pre-facilitator settle failure no longer holds the lock until its TTL. The wire contract is unchanged.
