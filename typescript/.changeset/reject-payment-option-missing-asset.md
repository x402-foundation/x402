---
"@x402/core": patch
"@x402/evm": patch
---

Fixed `x402Client.createPaymentPayload` throwing `TypeError` when a payment option has a missing or non-string `asset`. The client drops that option and pays a remaining valid option. If none remain, it throws an error that the payment requirement is missing `asset`. EVM `findDefaultAsset` returns undefined for a non-string asset.
