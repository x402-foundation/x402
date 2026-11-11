---
"x402-express": patch
"x402-hono": patch
"x402-next": patch
---

Refuse to settle a payment carried on a HEAD request that reached a paid route through the GET fallback or a method-less route, in the v1 payment middlewares. A HEAD response cannot carry content, so settling on one charges for a result that cannot be delivered. A route declared as `HEAD /path` settles as before. `withX402` in x402-next wraps one exported method handler and is unchanged.
