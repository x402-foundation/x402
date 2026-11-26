---
"@x402/aptos": patch
---

The exact Aptos facilitator now reads `0x1::fungible_asset::transfer` arguments as stores. It requires the sender's and `payTo`'s primary stores for `requirements.asset`, instead of comparing the store arguments with the asset metadata and `payTo` addresses, which rejected every real `fungible_asset::transfer` payment.
