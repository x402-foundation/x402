---
"@x402/svm": patch
---

Honor explicit `maxReclaimsPerTx` values above 16 for v1 rent cleanup, with batches bounded by the actual wire, account, and instruction limits. Preserve the default of 8, invalid-value fallback, and v0 cap of 16.
