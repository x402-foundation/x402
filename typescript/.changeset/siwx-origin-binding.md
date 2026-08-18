---
"@x402/extensions": minor
"@x402/core": minor
"@x402/fetch": minor
"@x402/axios": minor
---

Require SIWX client origin binding before signing. `x402HTTPClient.handlePaymentRequired` now accepts the response URL and passes it to hooks via `PaymentRequiredContext.requestUrl`.

**`createSIWxPayload(serverExtension, signer, requestUrl)`** — new required third argument: the final URL of the 402 response (after redirects). Callers that previously invoked `createSIWxPayload(info, signer)` must pass the response URL; signing is refused when challenge `domain` or `uri` origin does not match that URL's origin.
