---
"@x402/core": patch
---

Facilitator before-verify and before-settle hooks can return an optional `message` with an abort. Verify copies it to `invalidMessage`. Settle resolves with `success: false` and copies it to `errorMessage`, including when the message is an empty string. An omitted message leaves that field undefined. `settle()` no longer rejects with `Settlement aborted:` when a before-settle hook aborts.
