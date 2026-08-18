---
"@x402/svm": patch
---

Harden the SVM `upto` facilitator and rent cleanup manager:

- Clamp `maxReclaimsPerTx` (and fall back non-positive values to the default) so a misconfigured operator setting cannot build a reclaim batch that fails to serialize or loops forever.
- Guard `BigInt(requirements.amount)` in claim verification so a malformed requirement is reported as a structured failure instead of an uncaught exception.
- Distinguish a settlement confirmation timeout (`settlement_confirmation_timeout`) from an onchain rejection (`transaction_failed`) in claim settlement, and keep the dedup cache entry on timeout so a retry cannot race a second `settle_and_seal` against a transaction that may still land.
- Remove the unused `simulateZeroChargeSettle` helper.
- Reuse `BASIS_POINTS_DENOMINATOR` instead of a duplicated literal in the rent cleanup manager's abandon-close split.
