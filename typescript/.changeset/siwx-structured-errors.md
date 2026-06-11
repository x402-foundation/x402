---
"@x402/extensions": minor
---

Added a `code` field (new exported `SIWxValidationCode` union) to `validateSIWxMessage` failure results and a `cause` field carrying the original thrown error to `verifySIWxSignature` failures when verification threw, so callers can branch on failures without string matching. Also fixed `verifySIWxSignature` rejecting on malformed CAIP-2 chainIds; it now resolves `{ valid: false }` as documented.
