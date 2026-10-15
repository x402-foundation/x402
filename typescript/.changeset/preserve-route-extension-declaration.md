---
"@x402/core": patch
---

Stop `createPaymentRequiredResponse` from mutating the extensions object it is given. The response aliased that object and the `enrichPaymentRequiredResponse` output was written through the alias, so a declaration was replaced by the 402 enrichment before `enrichSettlementResponse` could read it. For `offer-receipt` that meant a route declaring `includeTxHash: true` always issued receipts with an empty `transaction`.
