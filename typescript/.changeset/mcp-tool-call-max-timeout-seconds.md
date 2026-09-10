---
"@x402/mcp": patch
---

MCP tool calls now derive their request timeout from the accept's `maxTimeoutSeconds` (default 300s) instead of the MCP SDK's 60s default, so slow-finality settlements no longer abort mid-flight. The initial 402 probe uses a 300s ceiling unless the caller passes an explicit `timeout`.
