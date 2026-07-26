---
"@x402/core": patch
---

Throw a clear error when the `HTTPFacilitatorClient` `createAuthHeaders` callback returns a flat headers object instead of one keyed by facilitator path (`verify`/`settle`/`supported`). Previously this silently dropped authentication on every request. Also documented the expected shape on the `createAuthHeaders` option.
