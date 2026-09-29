---
"@x402/core": minor
---

Add `spendControls.maxTimeoutSeconds`: the client now rejects accepts whose `maxTimeoutSeconds` (the validity window schemes sign, e.g. EIP-3009 `validBefore = now + maxTimeoutSeconds`) exceeds a cap, so a 402 can no longer make a signed authorization stay cashable for years. Defaults to `DEFAULT_MAX_TIMEOUT_SECONDS` (3600 seconds); set a number to change it or `false` to disable. Non-numeric `maxTimeoutSeconds` values are rejected while the cap is on. `spendControls: false` still disables all spend controls.
