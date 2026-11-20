---
"@x402/svm": minor
---

Add multi-payee splits to the exact scheme (scheme_exact_svm.md §5): clients build one transfer per leg plus fee-payer-funded ATA creation for marked recipients, accepted by default without a split-specific approval hook (the quoted total can pay multiple recipients; applications can screen recipients through `onBeforePaymentCreation`); servers check splits against the facilitator's advertised `maxSplits` / `ataCreationSponsored`; facilitators verify splits on Path 1, Path 2 and post-settlement, and advertise the capabilities when `maxSplits` / `ataCreationSponsored` are set. Split charges work on transaction versions 0 and 1.
