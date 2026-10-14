---
"@x402/core": patch
---

Warn once per route when the encoded `PAYMENT-REQUIRED` header exceeds 8,190 bytes, and again past 16 KB. Python aiohttp rejects header values over 8,190 bytes and Node.js `fetch` fails on more than 16 KB of headers, so those clients never see the 402. The warning names the route, the encoded size and the largest fields.
