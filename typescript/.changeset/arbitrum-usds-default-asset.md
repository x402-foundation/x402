---
"@x402/evm": minor
---

Add Sperax USD (USDs) on Arbitrum One (`eip155:42161`) as a Permit2 default asset, so `"$0.10 USDs"` resolves and clients recognize USDs under default spend controls. Bare `"$0.10"` still resolves to USDC. USDs has no EIP-3009 and its `permit()` does not set allowances, so the entry omits `supportsEip2612` and first payments use ERC-20 approval gas sponsoring.
