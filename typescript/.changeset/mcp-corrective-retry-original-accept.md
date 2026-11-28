---
"@x402/mcp": patch
---

Corrective MCP retries sign the payment terms that were already approved. A later 402 can still update payment state for recovery, and it does not change the amount, asset, or recipient of that approval.
