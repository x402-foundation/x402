---
"@x402/core": patch
---

Isolate x402Facilitator lifecycle hook errors: a throwing beforeVerify/afterVerify/beforeSettle/afterSettle/onVerifyFailure/onSettleFailure hook is logged and skipped instead of altering the verify/settle outcome. Previously a throwing afterSettle hook fired onSettleFailure hooks and rejected settle() after settlement had already executed onchain. Mirrors the resource server's hook handling.
