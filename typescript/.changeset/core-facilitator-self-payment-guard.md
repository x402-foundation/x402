---
"@x402/core": patch
---

Enforce self-payment prohibition (`payer !== payTo`) in `x402Facilitator.verify()` and `x402Facilitator.settle()` with error code `invalid_self_payment`, and document pre-signing multi-transaction group sponsorship and anti-wash-settlement conformance invariants in `specs/schemes/exact/scheme_exact.md` and `specs/x402-specification-v2.md`.
