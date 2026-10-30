---
"@x402/mcp": minor
---

Added `captureRawToolCalls(server)` so payment schemes can bind the MCP `tools/call` request the client actually sent. The MCP SDK validates tool arguments against the input schema before calling the tool, so the payment wrapper only saw arguments with defaults applied and unknown keys removed, and derived the tool name from `resource.url` (or the placeholder `"paid_tool"`). After opting in, the transport context passed to `createPaymentRequiredResponse`, verification, settlement, and cancellation carries `rawToolCall: { name, arguments?, _meta? }`, a frozen copy of the params as received, and `toolName` is the actual tool name. Without the opt-in, the context is unchanged. `MCPPaymentTransportContext` and `MCPRawToolCall` are now exported types.
