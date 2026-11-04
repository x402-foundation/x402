---
'@x402/core': minor
---

Pre-facilitator settlement failures (for example a `beforeSettle` abort or throw, or `enrichSettlementPayload` failing) now dispatch `settlement_preflight_failed` cancellation to `onVerifiedPaymentCanceled` hooks and the scheme's `settleOnCancel`, then rethrow the original error. No cancel is dispatched for an after-handler settle on a flow that already settled before the handler. `onVerifiedPaymentCanceled` contexts also gain an optional `verifyResult`, set for `after_verify_aborted`. **Behavior change:** `onSettleFailure` hooks now run only once the facilitator was reached, so they no longer fire (or recover) for failures that happen before the facilitator call, matching the Go SDK. `VerifiedPaymentCancellationReason` gains `settlement_preflight_failed`; exhaustive `switch` statements over it need a new case.
