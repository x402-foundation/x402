---
"@x402/evm": patch
---

Reject non-canonical (high-s) EOA signatures in exact-scheme EIP-3009 verify (v1 and v2) with `invalid_exact_evm_non_canonical_signature`. Only a 65-byte signature from a payer with no bytecode is rejected. Adds the exported `isCanonicalEcdsaSignature` and `isPlainNonCanonicalEcdsaSignature` helpers.
