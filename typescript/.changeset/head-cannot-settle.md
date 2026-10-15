---
"@x402/core": patch
---

Refuse to settle a payment carried on a HEAD request. A HEAD response cannot carry content, so settling on one charges for a result that cannot be delivered. The challenge is still served over HEAD, so the price stays discoverable and the unpaid-HEAD bypass stays closed.
