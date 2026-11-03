---
"@x402/next": patch
---

Fixed bundled Next.js builds logging a bazaar load failure when the bazaar extension is already registered. Route validation still runs through a static import of `validateBazaarRouteExtensions`.
