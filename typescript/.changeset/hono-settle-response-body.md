---
"@x402/hono": patch
---

Rebuild the response from the buffered body after successful settlement, so the body sent to the client no longer depends on the state of the handler's body stream across the settlement await
