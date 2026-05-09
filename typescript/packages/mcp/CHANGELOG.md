# @x402/mcp Changelog

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
