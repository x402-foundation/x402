---
"@x402/extensions": minor
---

Reshaped `SIWxValidationResult` into a discriminated union aligned with the facilitator verify response: `{ isValid: true } | { isValid: false; invalidReason: SIWxValidationCode; invalidMessage: string }`, where `invalidReason` is a stable spec-documented `invalid_siwx_*` code, replacing the previous `{ valid, error }` shape. Added a `cause` field carrying the original thrown error to `verifySIWxSignature` failures when verification threw, so callers can branch on failures without string matching. Also fixed `verifySIWxSignature` rejecting on malformed CAIP-2 chainIds; it now resolves with a failure result as documented.
