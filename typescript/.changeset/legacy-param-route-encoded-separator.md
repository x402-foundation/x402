---
"x402": patch
---

Fixed a payment bypass on parameterised routes: a parameter containing `%2F` or `%5C` (for example `/api/users/a%2Fb`) no longer skips the paywall. `findMatchingRoute` now also matches the path as the router splits it, with encoded separators kept inside their segment.
