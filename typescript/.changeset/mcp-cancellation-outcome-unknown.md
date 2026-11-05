---
"@x402/mcp": patch
---

When payment cancellation fails after metering or a failed tool result, the MCP server returns a tool error that says payment cancellation outcome is unknown. The result keeps the tool error output, omits a new payment offer, and attaches only a receipt that was already known.
