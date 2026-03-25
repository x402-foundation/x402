---
'@x402/core': minor
'@x402/express': minor
'@x402/hono': minor
---

Add SettlementOverrides support for partial settlement (upto scheme). Route handlers can call setSettlementOverrides() to settle less than the authorized maximum, enabling usage-based billing.
