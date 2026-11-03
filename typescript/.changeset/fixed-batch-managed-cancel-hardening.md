---
'@x402/core': minor
'@x402/evm': patch
---

Harden facilitator-managed batch settlement: pre-facilitator settlement failures now dispatch `settlement_preflight_failed` cancellation with trusted verify results available to cancellation hooks, and managed EVM state parsing fails closed without releasing or corrupting facilitator admission state. Abandoned request contexts expire after twice their admission-lock TTL, malformed replica state is ignored, and refund enrichment failures retain the pending lock handle. A throwing `beforeSettle` hook now fails the settle closed instead of being warned and skipped, and `onSettleFailure` hooks run only once the facilitator was reached, matching the Go SDK. The wire contract is unchanged.
