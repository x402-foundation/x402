---
'@x402/evm': patch
'x402': patch
---

Align the exact EVM authorization-value-mismatch error code across SDKs. The `@x402/evm` facilitator now emits the spec-documented `invalid_exact_evm_payload_authorization_value_mismatch` reason when an authorization value does not match the required amount, matching the Go facilitator (the previous `invalid_exact_evm_authorization_value` string was not in the spec error registry). The legacy `x402` `ErrorReasons` enum now accepts this reason so responses from the Python/Go facilitators no longer fail TypeScript schema validation.
