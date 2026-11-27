---
"@x402/express": patch
---

When settlement fails after the route handler ran, the 402 (or 502) response no longer carries the headers the handler set, such as `Set-Cookie` or `Content-Disposition`. The buffered body was already dropped; its headers are now dropped too, and headers set before the handler (for example CORS) are kept. Hono and Next.js already answer with a fresh response.
