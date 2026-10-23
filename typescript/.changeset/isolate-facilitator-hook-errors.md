---
"@x402/core": patch
---

Isolate errors from advisory `x402Facilitator` hooks: a throwing `afterVerify`, `afterSettle`, `onVerifyFailure` or `onSettleFailure` hook is now logged and skipped instead of changing the verify/settle outcome. Previously a throwing `afterSettle` hook fired `onSettleFailure` hooks and rejected `settle()` after settlement had already executed onchain. Gate hooks (`beforeVerify`, `beforeSettle`) still fail closed: a throw stops verification or settlement before the scheme facilitator is called.
