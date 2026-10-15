---
"@x402/evm": patch
---

Normalize the EIP-3009 signature `v` to 27 or 28 before calling `transferWithAuthorization`, so signatures that encode `v` as 0 or 1 are no longer rejected on-chain.
