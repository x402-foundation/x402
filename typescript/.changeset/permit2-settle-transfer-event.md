---
"@x402/evm": patch
---

Verify the ERC-20 Transfer event in Permit2 settle receipts (exact and upto) instead of trusting receipt status alone, so underpaying or non-conforming tokens are rejected at settlement
