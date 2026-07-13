---
"@x402/extensions": minor
---

Added the `swap-settlement` extension module: canonical encodings (RFC 8785 requirements hash, quote-bound EIP-3009 nonce derivation), typed-data builders for the Permit2 witness transfer, EIP-3009 authorization, and the allowance intent (EIP-2612 permits use `@x402/evm`'s existing helpers), `withSwapSettlement` client scheme wrapper for automatic token-agnostic payments, `declareSwapSettlementExtension`/`swapSettlementResourceServerExtension` for resource servers, `extractSwapSettlementInfo`/`validateSwapSettlementInfo` for facilitators, and the `x402SwapSettler` contract ABI. See `specs/extensions/swap_settlement.md`.
