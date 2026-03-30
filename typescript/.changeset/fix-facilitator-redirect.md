---
'@x402/core': patch
---

Fixed HTTPFacilitatorClient not following 308 redirects from facilitator endpoints. Normalized base URL to strip trailing slashes and explicitly set `redirect: "follow"` on all fetch calls for cross-runtime compatibility.
