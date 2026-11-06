---
"@x402/evm": patch
---

The `exact` EVM facilitator now reports a recipient mismatch as `invalid_exact_evm_payload_recipient_mismatch`, the reason listed in the x402 v2 specification and emitted by the Python facilitator, instead of `invalid_exact_evm_recipient_mismatch`. The legacy `x402` client already accepts only the specified reason.
