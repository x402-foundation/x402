---
"@x402/sui": patch
---

Check a sponsored payment's simulated effects before the sponsor co-signs it at settle, reusing a recent verify of the same payment when there is one, and keep the transaction digest on settle errors.
