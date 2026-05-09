---
'@x402/core': patch
---

Log the `EXTENSION-RESPONSES` header from facilitator verify/settle responses. The HTTP facilitator client decodes the header and logs allowlisted fields (`status`, `rejectedReason`, `reason`, `code`) without attaching data to `VerifyResponse` or `SettleResponse`.
