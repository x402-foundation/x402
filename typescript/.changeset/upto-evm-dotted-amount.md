---
"@x402/evm": patch
---

`UptoEvmScheme.enhancePaymentRequirements` now converts a decimal asset amount (for example `{ amount: "0.01", asset }` for a default asset) to atomic units, as the exact EVM server and the Python and Go upto servers do. Previously the dotted string was sent unchanged in the 402. A dotted amount for an asset that is not a known default now throws.
