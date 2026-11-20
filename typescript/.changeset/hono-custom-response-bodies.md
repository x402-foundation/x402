---
"@x402/hono": patch
---

Fixed custom unpaid and settlement-failure string responses being JSON-encoded for non-JSON content types. Preserved declared content types and JSON serialization for JSON responses.
