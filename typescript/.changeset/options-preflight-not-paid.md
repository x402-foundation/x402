---
"@x402/core": patch
---

Fixed method-less routes and single route configs matching `OPTIONS` preflight requests, which answered the browser's CORS preflight with a 402. Routes keyed explicitly as `"OPTIONS /path"` still require payment.
