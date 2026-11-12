---
"@x402/mcp": patch
---

When payment cancellation fails after metering or a failed tool result, the MCP server returns a tool error that says payment cancellation outcome is unknown. The result keeps the tool error output, omits a new payment offer, and attaches only a receipt that was already known. ([#4152](https://github.com/x402-foundation/x402/pull/4152)) - Thanks [@PhilBot402](https://github.com/PhilBot402) and [@phdargen](https://github.com/phdargen)!
