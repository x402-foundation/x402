---
"@x402/extensions": patch
---

The bazaar `iconUrl` check strips a trailing dot from the host before its loopback checks, so `http://localhost./` is rejected like `http://localhost/`.
