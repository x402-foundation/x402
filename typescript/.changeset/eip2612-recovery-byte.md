---
"@x402/evm": patch
---

Normalize the EIP-2612 `permit` recovery byte to 27/28 in `splitEip2612Signature`, so signatures whose last byte is the raw y-parity (0/1) no longer fail on `ecrecover`-based tokens.
