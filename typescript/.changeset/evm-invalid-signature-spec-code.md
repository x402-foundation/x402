---
"@x402/evm": patch
---

The `exact` EVM facilitator now reports an invalid authorization signature as `invalid_exact_evm_payload_signature`, the reason listed in the x402 v2 specification and emitted by the Python facilitator, instead of `invalid_exact_evm_signature`. The v1 `exact` facilitator, which shares the constant, now matches the Go v1 facilitator as well.
