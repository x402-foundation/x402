---
"@x402/evm": patch
---

Normalize the EIP-2612 `permit` recovery byte to 27/28 in `splitEip2612Signature`, so signatures whose last byte is the raw y-parity (0/1) no longer fail on `ecrecover`-based tokens. ([#3583](https://github.com/x402-foundation/x402/pull/3583)) - Thanks [@artofbitcoin](https://github.com/artofbitcoin) and [@claude](https://github.com/claude)!
