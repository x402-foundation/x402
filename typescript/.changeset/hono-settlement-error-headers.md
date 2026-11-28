---
"@x402/hono": patch
---

When settlement throws after the route handler ran, the 502 (invalid facilitator response) or 402 response no longer carries the headers the handler set, such as `Set-Cookie` or `Content-Disposition`.
