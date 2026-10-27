---
"@x402/svm": patch
---

Honor explicit `maxReclaimsPerTx` values above 16 for v1 rent cleanup, with batches bounded by the actual wire, account, and instruction limits. V1 cleanup now defaults to `DEFAULT_MAX_RECLAIMS_PER_TX_V1` (62), the most reclaims that fit one v1 transaction with a shared fee and rent payer; v0 keeps its default of 8, invalid-value fallback, and cap of 16.
