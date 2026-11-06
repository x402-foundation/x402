---
"@x402/lnbtc": minor
---

Add `@x402/lnbtc`: the `exact` scheme on Bitcoin Lightning (`lnbtc`) with BOLT11 invoices and the `upfront` flow. Clients pay a request-bound invoice and return its preimage; facilitators verify the preimage locally and consume the payment hash in a replay store.
