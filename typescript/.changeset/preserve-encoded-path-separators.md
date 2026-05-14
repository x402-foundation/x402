---
'@x402/core': patch
---

Preserve %2F/%5C in normalizePath so encoded path separators can no longer hide segment boundaries from :param route regexes, closing a paywall bypass on requests like /api/report/a%2Fb.
