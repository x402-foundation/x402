---
"@x402/stellar": patch
---

Accept CAP-67 transfer events in the exact facilitator, so a payment to a muxed (`M...`) `payTo` verifies. The event carries the base account in the `to` topic and `{ amount, to_muxed_id }` as data; both are now checked against the muxed address.
