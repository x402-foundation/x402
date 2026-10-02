---
'@x402/stellar': patch
---

Fixed `ExactStellarScheme.settle` collapsing every non-`PENDING` `sendTransaction`
result into the same constant `errorReason`. The RPC's `status`, `errorResult` code,
and `latestLedger` are now surfaced via `errorMessage`/`extra`, and a `TRY_AGAIN_LATER`
response is reported with a distinct, retryable `errorReason`
(`settle_exact_stellar_transaction_submission_retryable`) instead of being treated as
a terminal failure identical to `ERROR`.
