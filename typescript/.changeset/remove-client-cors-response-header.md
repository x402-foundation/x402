---
"@x402/fetch": patch
"@x402/axios": patch
---

Removed the response-only Access-Control-Expose-Headers header automatically added to payment retry requests, avoiding unnecessary CORS preflight failures in browsers. Servers remain responsible for exposing payment response headers.
