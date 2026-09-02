# @x402/mcp Changelog

## 2.24.0

### Minor Changes

- [8707ab7](https://github.com/x402-foundation/x402/commit/8707ab7): Withhold MCP tool content when after-handler settlement returns `{ success: false }`. ([#3246](https://github.com/x402-foundation/x402/pull/3246)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies
  - @x402/core@2.24.0

## 2.23.0

### Minor Changes

- [79b6259](https://github.com/x402-foundation/x402/commit/79b6259): Add scheme hooks for usage-based payments: `SchemeNetworkServer.settleOnCancel` settles once when a verified payment is canceled, and `dynamicExtraFields` excludes per-response `extra` keys from v2 requirement matching. Export `resolveFailurePathSettlement` and use it in MCP so handler failure/throw paths prefer cancel/refund receipts (with deposit recovery `extra` on failed cancel) over echoing the before-handler deposit alone. ([#3094](https://github.com/x402-foundation/x402/pull/3094)) - Thanks [@phdargen](https://github.com/phdargen) and [@lgalabru](https://github.com/lgalabru)!
- Updated dependencies [79b6259](https://github.com/x402-foundation/x402/commit/79b6259)
- Updated dependencies [4f58723](https://github.com/x402-foundation/x402/commit/4f58723)
- Updated dependencies [ab1a31a](https://github.com/x402-foundation/x402/commit/ab1a31a)
- Updated dependencies [c2612d3](https://github.com/x402-foundation/x402/commit/c2612d3)
- Updated dependencies [656437e](https://github.com/x402-foundation/x402/commit/656437e)
  - @x402/core@2.23.0

### Patch Changes

- [4f58723](https://github.com/x402-foundation/x402/commit/4f58723): Normalize each mechanism's default assets into `DEFAULT_ASSETS` + `getDefaultAsset` / `findDefaultAsset`, and add client `spendControls`: by default only recognized pegged assets are allowed with a `$1` USD cap; opt into other tokens via `allowedAssets` (list with optional integer atomic `maxAmountPerPayment`, or `true` to allow any); pass `spendControls: false` to disable all spend controls. A non-integer per-asset cap is a config error; a non-integer 402 amount on that path is dropped. Keeta, XRPL, and Concordium now ship USD defaults (USDC, RLUSD, USDR). XRPL pins the RLUSD issuer in the client scheme before signing. `$` settlement overrides throw when `getAssetDecimals` is unknown instead of guessing 6 decimals. Notable API moves: `DEFAULT_STABLECOINS` / `USDC_CONFIG` / `DEFAULT_ASSET_BY_NETWORK` → `DEFAULT_ASSETS` (list per network); identifier field `address` / `asaId` → `asset`; TVM `getDefaultAsset` returns an entry (use `.asset`). EVM `getAssetDecimals` is asset-aware; aptos unknown networks throw; EVM/SVM register helpers scope v1 networks to `config.networks`. Paywall uses `spendControls: false` (UI approval); MCP forwards `spendControls`. ([#3124](https://github.com/x402-foundation/x402/pull/3124)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.22.0

### Minor Changes

- [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e): Validate unsupported `paymentFlow` / `assetTransferMethod` at HTTP server construction and MCP `createPaymentWrapper` when the scheme is registered, and return a generic internal error from HTTP adapters and MCP wrappers for unexpected failures instead of leaking internal error details to clients. ([#3053](https://github.com/x402-foundation/x402/pull/3053)) - Thanks [@phdargen](https://github.com/phdargen)!
- [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e): Require ATM-keyed `paymentFlows` (and `defaultAssetTransferMethod`) on every `SchemeNetworkServer`. Core resolves ATM/flow from the table, rejects unsupported combinations, and always signals non-`authorization` `paymentFlow` on the 402 wire. All schemes currently declare `authorization` only. ([#3053](https://github.com/x402-foundation/x402/pull/3053)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies [37412e7](https://github.com/x402-foundation/x402/commit/37412e7)
- Updated dependencies [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e)
- Updated dependencies [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e)
- Updated dependencies [1601942](https://github.com/x402-foundation/x402/commit/1601942)
  - @x402/core@2.22.0

## 2.21.0

### Minor Changes

- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [e335d4f](https://github.com/x402-foundation/x402/commit/e335d4f)
- Updated dependencies [183b270](https://github.com/x402-foundation/x402/commit/183b270)
- Updated dependencies [ee1b148](https://github.com/x402-foundation/x402/commit/ee1b148)
- Updated dependencies [e805616](https://github.com/x402-foundation/x402/commit/e805616)
- Updated dependencies [5192e50](https://github.com/x402-foundation/x402/commit/5192e50)

  - @x402/core@2.21.0

- [08e84ab](https://github.com/x402-foundation/x402/commit/08e84ab): Plumb policies and paymentRequirementsSelector through createx402MCPClient so the documented factory can bound agent spend. ([#3034](https://github.com/x402-foundation/x402/pull/3034)) - Thanks [@SashaMIT](https://github.com/SashaMIT)!
- [c427425](https://github.com/x402-foundation/x402/commit/c427425): Re-run onPaymentRequired / onPaymentRequested gates before signing a corrective-402 recovery payment. ([#3033](https://github.com/x402-foundation/x402/pull/3033)) - Thanks [@SashaMIT](https://github.com/SashaMIT)!

## 2.20.0

### Minor Changes

- Updated dependencies [4453a92](https://github.com/x402-foundation/x402/commit/4453a92)
  - @x402/core@2.20.0

## 2.19.0

### Minor Changes

- Updated dependencies [c72cfee](https://github.com/x402-foundation/x402/commit/c72cfee)
  - @x402/core@2.19.0

## 2.18.0

### Minor Changes

- Updated dependencies [a3ad102](https://github.com/x402-foundation/x402/commit/a3ad102)
  - @x402/core@2.18.0

### Patch Changes

- [a3ad102](https://github.com/x402-foundation/x402/commit/a3ad102): Fixed cross-SDK MCP interop: optional `PaymentRequired`/`ResourceInfo`/`PaymentPayload` wire fields serialized as explicit `null` by the Python and Go SDKs are now accepted and normalized to `undefined` instead of failing validation. The MCP client routes both result and error extraction through `parsePaymentRequired`, so 402 responses from other implementations reliably trigger auto-payment. ([#2774](https://github.com/x402-foundation/x402/pull/2774)) - Thanks [@phdargen](https://github.com/phdargen)!

## 2.17.0

### Minor Changes

- Updated dependencies [266b19d](https://github.com/x402-foundation/x402/commit/266b19d)
  - @x402/core@2.17.0

## 2.16.0

### Minor Changes

- Updated dependencies [59ac597](https://github.com/x402-foundation/x402/commit/59ac597)
  - @x402/core@2.16.0

## 2.15.0

### Minor Changes

- Updated dependencies [bfa580e](https://github.com/x402-foundation/x402/commit/bfa580e)
- Updated dependencies [3a60816](https://github.com/x402-foundation/x402/commit/3a60816)
- Updated dependencies [7539e93](https://github.com/x402-foundation/x402/commit/7539e93)
  - @x402/core@2.15.0

## 2.14.0

### Minor Changes

- 4a5fd5b: Preserve existing MCP response metadata when adding x402 payment metadata.
- be788e0: Thread Bazaar service metadata from HTTP `RouteConfig` and MCP `PaymentWrapperConfig` into `PaymentRequired.resource`, and extend bazaar facilitator discovery/catalog types so verified payments persist description, MIME type, service metadata, and echoed extension payloads.
- Updated dependencies [be788e0]
- Updated dependencies [0af31dd]
  - @x402/core@2.14.0

## 2.13.0

### Minor Changes

- 5fca9f3: Implemented missing hook primitives needed for batch-settlement aligning with http transport
- Updated dependencies [ad08a9a]
- Updated dependencies [5fca9f3]
- Updated dependencies [95f2094]
- Updated dependencies [49ea054]
  - @x402/core@2.13.0

## 2.12.0

### Minor Changes

- ee7c156: chore: tighten viem dependency floor to ^2.48.11

  Raises the viem floor in every `@x402/*` package.json that lists viem as a direct dep so future `pnpm install` re-resolutions cannot regress below this version. Fixes the incomplete tightening from #2013.

- Updated dependencies [608034f]
- Updated dependencies [d235050]
- Updated dependencies [45d7d19]
  - @x402/core@2.12.0

## 2.11.0

### Minor Changes

- 71a223d: Added `extensions` field to `PaymentWrapperConfig` so paid MCP tools can declare Bazaar discovery metadata and appear in `/discovery/resources`.

### Patch Changes

- a051f48: Enables `ResourceServerExtension` to register resource-server verify/settle hooks, and enforces extension mutation policy: `enrichPaymentRequiredResponse` may only change `payTo` / `amount` / `asset` when those baseline values are vacant; `scheme` / `network` / `maxTimeoutSeconds` and baseline `extra` entries are immutable. `enrichSettlementResponse` may not rewrite facilitator core fields (`success`, `transaction`, `network`, etc.). Lifecycle hook contexts are typed as read-only for core protocol fields.
- Updated dependencies [a051f48]
- Updated dependencies [dc04108]
  - @x402/core@2.11.0

## 2.10.0

### Minor Changes

- 9424291: chore: bump viem lockfile to 2.47.12

  Updates the resolved viem version across all direct dependencies, adding chain definitions for Mezo Testnet, MegaETH, Stable, and Stable Testnet that were missing from previously locked versions.

  - @x402/core@2.10.0

## 2.9.0

### Minor Changes

- 2250cae: Migrated project from coinbase/x402 to x402-foundation/x402 organization

### Patch Changes

- Updated dependencies [8cf3fca]
- Updated dependencies [c0e3969]
- Updated dependencies [2250cae]
- Updated dependencies [d352574]
  - @x402/core@2.9.0

## 2.8.0

### Minor Changes

- Updated dependencies [067f297]
- Updated dependencies [4c1e44f]
- Updated dependencies [5135fab]
  - @x402/core@2.8.0

## 2.7.0

### Minor Changes

- Updated dependencies [8931cb3]
  - @x402/core@2.7.0

## 2.6.0

### Minor Changes

- Updated dependencies
  - @x402/core@2.6.0

## 2.5.0

### Minor Changes

- Updated dependencies [96a9db0]
- Updated dependencies [d0a2b11]
- Updated dependencies
  - @x402/core@2.5.0

## 2.4.0

### Minor Changes

- Updated dependencies [57a5488]
- Updated dependencies [018181b]
- Updated dependencies [3fb55d7]
  - @x402/core@2.4.0

## 2.3.0

### Patch Changes

- 9ec9f15: Fixed select payment requirements
- Updated dependencies [9ec9f15]
  - @x402/core@2.3.1

## 2.3.0-alpha

- Initial alpha prerelease of @x402/mcp package for Model Context Protocol integration with x402 payment protocol.
