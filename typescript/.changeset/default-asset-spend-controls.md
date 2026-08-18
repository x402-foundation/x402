---
"@x402/core": minor
"@x402/evm": minor
"@x402/svm": minor
"@x402/avm": minor
"@x402/tvm": minor
"@x402/near": minor
"@x402/hedera": minor
"@x402/aptos": minor
"@x402/stellar": minor
"@x402/keeta": minor
"@x402/xrpl": minor
"@x402/concordium": minor
"@x402/paywall": patch
"@x402/mcp": patch
---

Normalize each mechanism's default assets into `DEFAULT_ASSETS` + `getDefaultAsset` / `findDefaultAsset`, and add client `spendControls`: by default only recognized pegged assets are allowed with a `$1` USD cap; opt into other tokens via `allowedAssets` (list with optional integer atomic `maxAmountPerPayment`, or `true` to allow any); pass `spendControls: false` to disable all spend controls. A non-integer per-asset cap is a config error; a non-integer 402 amount on that path is dropped.

Keeta, XRPL, and Concordium now ship USD defaults (USDC, RLUSD, USDR). XRPL pins the RLUSD issuer in the client scheme before signing. `$` settlement overrides throw when `getAssetDecimals` is unknown instead of guessing 6 decimals.

Notable API moves: `DEFAULT_STABLECOINS` / `USDC_CONFIG` / `DEFAULT_ASSET_BY_NETWORK` → `DEFAULT_ASSETS` (list per network); identifier field `address` / `asaId` → `asset`; TVM `getDefaultAsset` returns an entry (use `.asset`). EVM `getAssetDecimals` is asset-aware; aptos unknown networks throw; EVM/SVM register helpers scope v1 networks to `config.networks`. Paywall uses `spendControls: false` (UI approval); MCP forwards `spendControls`.
