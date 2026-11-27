---
"@x402/sui": minor
---

Add `@x402/sui`, the `exact` payment scheme for Sui. The facilitator accepts any transaction whose effects credit `payTo` with exactly `amount`. It can optionally sponsor gas (advertised as `feePayer`, with a budget cap) and reports success at most once per transaction.
