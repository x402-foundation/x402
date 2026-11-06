---
"@x402/core": minor
"@x402/fetch": minor
"@x402/mcp": minor
---

Pass the call being paid for to payment creation. `createPaymentPayload(paymentRequired, { call })` accepts an optional `PaymentCall` (`{ kind: "http", method, url, headers, getBody? }` or `{ kind: "mcp", toolName, arguments }`), validates it and forwards it to the scheme in `PaymentPayloadContext.call` and to the payment creation hooks, so request-binding schemes see the right call when one client creates several payments concurrently. `@x402/fetch` fills it from the original request, with a lazy, abortable body read; `@x402/mcp` snapshots the tool arguments once per call and transmits that snapshot on the unpaid, paid and recovery RPCs.
