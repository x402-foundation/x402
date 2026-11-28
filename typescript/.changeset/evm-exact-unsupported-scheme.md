---
"@x402/evm": patch
---

The exact EVM facilitator reports a scheme mismatch as `unsupported_scheme`, the reason listed in section 9 of the x402 v2 specification and emitted by the Python facilitator, instead of `invalid_exact_evm_scheme` (EIP-3009, v1 and v2) or `unsupported_payload_type` (Permit2).
