---
"@x402/evm": patch
---

Normalize the ECDSA recovery byte to 27/28 before calling `transferWithAuthorization(..., v, r, s)` and EIP-2612 `permit`, so signatures whose last byte is the raw y-parity (0/1) no longer fail simulation and settlement on `ecrecover`-based tokens such as USDC.
