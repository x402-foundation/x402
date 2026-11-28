---
"@x402/core": patch
---

The facilitator routes a payment to the registration that lists its network before falling back to a wildcard match, so a wildcard registered earlier no longer shadows a later network-specific registration.
