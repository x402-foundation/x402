---
"@x402/xrpl": patch
---

Fix the exact XRPL client disconnecting before the default `autofill` resolved, which made payload creation fail with "websocket was closed".
