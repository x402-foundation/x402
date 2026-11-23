---
"@x402/core": minor
"@x402/express": minor
"@x402/hono": minor
"@x402/next": minor
"@x402/fastify": minor
---

Added `getVerifiedPayment()` to the Express, Hono, Fastify and Next (`withX402`) adapters. A route handler can now read the verified `paymentPayload`, the matched `paymentRequirements` and the facilitator-reported `payer` without decoding the `PAYMENT-SIGNATURE` header again. The `payment-verified` result of `x402HTTPResourceServer.processHTTPRequest` now carries `payer`, taken from the verify response or, for flows that settle before the handler, from that settlement. Core exports the `VerifiedPayment` type. The Python (`request.state.payment_payload`, `g.payment_payload`) and Go (`x402_payload`, `PayloadFromContext`) middleware already expose the payload and requirements to handlers.
