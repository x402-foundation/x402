---
"@x402/evm": patch
---

`ExactEvmScheme` (server) now fills missing `extra.name`, `extra.version` and `extra.assetTransferMethod` when a price is given as an asset amount for a known default asset, matching `"$..."` pricing and the Python server. Previously the client failed with "EIP-712 domain parameters (name, version) are required" unless the route set them by hand.
