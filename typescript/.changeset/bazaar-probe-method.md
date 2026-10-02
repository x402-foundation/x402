---
"@x402/extensions": patch
---

Bazaar no longer advertises a probe method that contradicts the declared input: a verbless route probed with GET for a body declaration now advertises POST (and vice versa) instead of `method: "GET"` with `bodyType` and `body`.
