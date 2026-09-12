---
"@x402/evm": patch
---

Add Celo mainnet USDT (`0x48065fbBE25f71C9282ddf5e1cD6D6A887483D5e`) and USAT (`0xD2ab3C9A02DBBAB236BfEC45D1d755DF4267F771`), both EIP-3009, as default assets for `eip155:42220`, so `"$0.10 USDT"` and `"$0.10 USAT"` resolve on Celo. Bare `"$0.10"` still resolves to USDC.
