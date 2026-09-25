---
"@x402/svm": minor
---

Negotiate the Solana transaction message version between facilitator, server and client for the `exact` scheme, ahead of transaction v1 (SIMD-0385).

- Facilitators (`exact` and the legacy x402 v1 `exact`) advertise the message versions they accept as `extra.transactionVersions` in `/supported`; the advertised set is `[0]`.
- Servers copy `transactionVersions` from the facilitator's supported kind into `PaymentRequirements.extra`.
- Clients build one of the advertised versions via `resolveTransactionVersion`: version 0 when the field is absent or lists `0`, otherwise they refuse with `unsupported_transaction_version`.
- Verifiers (`exact` static and smart-wallet paths, legacy x402 v1 `exact`) reject any message version they do not model with `unsupported_transaction_version` before inspecting signatures or instructions. Legacy messages remain accepted for backward compatibility but are deprecated and never advertised.
