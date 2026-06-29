---
"@x402/evm": patch
---

Harden the exact-scheme EIP-3009 facilitator verify path to reject non-canonical (high-s) ECDSA signatures before settlement (EIP-2 / SEC1 §4.1.4), instead of relying on the token's on-chain `InvalidSignatureS` revert. Not all ERC-3009 tokens enforce low-s, and the alternate `(r, n-s, v^1)` signature can read as a distinct authorization at the facilitator's retry/cache layer. Adds the exported `isCanonicalEcdsaSignature` helper and the `ErrInvalidSignatureS` (`invalid_exact_evm_non_canonical_signature`) reason. TypeScript parity for #2386 (Go: #2454).
