---
"@x402/evm": patch
---

The exact EVM facilitator rejects a non-canonical `PaymentRequirements.amount` during verify and settle with `invalid_exact_evm_required_amount`. The exact server rejects the same strings in `parsePrice` and after `enhancePaymentRequirements` converts a dotted human amount on a known asset.
