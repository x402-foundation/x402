---
"@x402/evm": patch
---

Fixed exact EVM verify reporting a failed payer `eth_getCode` as `invalid_exact_evm_signature`. The lookup failure is now `invalid_exact_evm_failed_to_verify_signature`, matching Go and Python, so a transient RPC error is not treated as a bad signature.
