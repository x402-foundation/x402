---
"@x402/work": minor
"@x402/core": patch
"@x402/mcp": patch
---

Add `@x402/work`, the `work` scheme: profile-defined proof-of-work payments with provider-issued native jobs, amount-derived targets, and atomic fingerprint consumption. In core, `enrichPaymentRequiredResponse` may now omit its own scheme's unavailable accepts, runs once per scheme and network, and receives the payment payload on HTTP and MCP error responses.
