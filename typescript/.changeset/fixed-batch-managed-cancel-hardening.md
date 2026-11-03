---
'@x402/core': minor
'@x402/evm': patch
---

Harden facilitator-managed batch settlement: pre-facilitator settlement failures now dispatch `settlement_preflight_failed` cancellation with trusted verify results available to cancellation hooks, and managed EVM state parsing fails closed without releasing or corrupting facilitator admission state. Abandoned request contexts expire after the server's own `maxTimeoutSeconds` (minimum 5 seconds) plus a 10-second grace, malformed replica state is ignored, and refund enrichment failures retain the pending lock handle. A throwing `beforeSettle` hook now fails the settle closed instead of being warned and skipped, and `onSettleFailure` hooks run only once the facilitator was reached, matching the Go SDK. Self-managed batch settlement now also releases its admission lock on `settlement_preflight_failed`, so a pre-facilitator settle failure no longer holds the lock until its TTL. The wire contract is unchanged.
