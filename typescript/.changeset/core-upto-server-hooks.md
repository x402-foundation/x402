---
'@x402/core': minor
'@x402/mcp': minor
---

Add scheme hooks for usage-based payments: `SchemeNetworkServer.settleOnCancel` settles once when a verified payment is canceled, and `dynamicExtraFields` excludes per-response `extra` keys from v2 requirement matching.

Export `resolveFailurePathSettlement` and use it in MCP so handler failure/throw paths prefer cancel/refund receipts (with deposit recovery `extra` on failed cancel) over echoing the before-handler deposit alone.
