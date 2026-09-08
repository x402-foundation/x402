---
"@x402/cardano": minor
---

Cardano `exact` scheme: facilitator-broadcast only (client submission and Hydra descoped), `verify()` checks value conservation and the fee floor without a phase-1 validator, `settle()` returns `settlement_pending` for the core retry instead of holding the connection, the duplicate-settlement guard defaults to a bounded in-memory store, and the server scheme issues Masumi quotes from route templates.
