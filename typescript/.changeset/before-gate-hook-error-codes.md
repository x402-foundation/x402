---
"@x402/core": patch
---

Rename resource-server gate hook throw outcomes to phase-specific codes: a throwing `beforeVerify` hook now returns `before_verify_hook_error` with message `before verify hook failed`, and a throwing `beforeSettle` hook now fails closed with `before_settle_hook_error` and `before settle hook failed`. Behavior is unchanged aside from the reason and message strings.
