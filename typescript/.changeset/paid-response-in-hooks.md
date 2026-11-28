---
"@x402/core": minor
"@x402/fetch": minor
---

`onPaymentResponse` hooks receive the paid request's HTTP response as `ctx.response`: `status`, `getHeader`, and, from `@x402/fetch`, `body()`, which reads a copy so the response returned to the caller stays unread. A hook can now tell a settled payment whose handler failed from one that delivered, and check what was delivered. `@x402/axios` passes `status` and `getHeader`. Transports without an HTTP response, such as MCP, pass no `response`.
