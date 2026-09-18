---
"@x402/evm": patch
---

`getEvmChainId` now requires a bare decimal CAIP-2 reference (`eip155:<digits>`). It used to call `parseInt`, which stops at the first non-digit, so `eip155:0x2105` resolved to chain ID `0` and `eip155:8453abc` to `8453` instead of being rejected — and that chain ID is signed into the EIP-712 domain for Permit2, EIP-3009 and batch-settlement. Chain IDs beyond `Number.MAX_SAFE_INTEGER` are now rejected instead of silently rounded. The Go and Python SDKs already reject all of these.
