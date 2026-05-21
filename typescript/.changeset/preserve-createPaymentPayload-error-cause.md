---
"@x402/fetch": patch
"@x402/axios": patch
---

Preserve original error as `cause` when `createPaymentPayload` throws

Previously, `wrapFetchWithPayment` and `wrapAxiosWithPayment` caught errors from
`client.createPaymentPayload(...)` and re-threw a new generic `Error`, discarding
the original error type and any structured fields. Callers could not distinguish
policy/guardrail failures from generic payment construction failures without
parsing the error message string.

The wrapper now passes `{ cause: error }` to the new `Error`, so callers can
inspect `error.cause` to access the original typed error.
