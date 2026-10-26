---
"@x402/evm": patch
---

Reject non-canonical (high-s) EOA signatures in exact-scheme EIP-3009 verify (v1 and v2) with `invalid_exact_evm_non_canonical_signature` (`ErrInvalidSignatureS`), instead of relying on the token's on-chain `InvalidSignatureS` revert. Matches Go #2454: only a 65-byte signature from a payer with no bytecode is rejected; deployed wallets and ERC-1271 / ERC-6492 wrappers are unaffected. Adds the exported `isCanonicalEcdsaSignature` and `isPlainNonCanonicalEcdsaSignature` helpers.
