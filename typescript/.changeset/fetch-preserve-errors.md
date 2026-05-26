---
"@x402/fetch": patch
"@x402/axios": patch
---

Preserve original errors thrown by `createPaymentPayload` instead of wrapping in a generic `Error`. Callers that throw typed errors (e.g. policy/guardrail failures) now propagate their original type and structured fields through `wrapFetchWithPayment` and `wrapAxiosWithPayment`.
