# @x402/extensions Changelog

## 2.11.0

### Minor Changes

- Updated dependencies [a051f48]
- Updated dependencies [dc04108]
  - @x402/core@2.11.0

## 2.10.0

### Minor Changes

- 9424291: chore: bump viem lockfile to 2.47.12

  Updates the resolved viem version across all direct dependencies, adding chain definitions for Mezo Testnet, MegaETH, Stable, and Stable Testnet that were missing from previously locked versions.

- a4e4911: Migrate SIWE dependency from `siwe` (Spruce) to `@signinwithethereum/siwe` (Ethereum Identity Foundation). The new package is the official successor, supports viem natively as a peer dependency, and maintains the same `SiweMessage` API.
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

- 4f2f4f3: Added auth-only route support in createSIWxRequestHook via accepts: [] detection
- 067f297: Added dynamic route support to the Bazaar discovery extension — servers can now declare `[param]` route segments that consolidate to a single catalog entry per route template, with automatic `pathParams` enrichment and `:param`-style `routeTemplate` in discovery output.

### Patch Changes

- Updated dependencies [067f297]
- Updated dependencies [4c1e44f]
- Updated dependencies [5135fab]
  - @x402/core@2.8.0

## 2.7.0

### Minor Changes

- 8b731cb: Replaced `sendRawApprovalAndSettle` with a generic `sendTransactions` signer method that accepts an array of pre-signed serialized transactions or unsigned call intents. The signer owns execution strategy (sequential, batched, or atomic bundling). Closed fail-open verification paths, aligned Permit2 amount check to exact match, and added `signerForNetwork` to the extensions package.
- f2bbb5c: Added offer-receipt extension to enable signed offers and receipts in x402 payment flows

### Patch Changes

- 34d2442: Removed dependencie on node’s crypto module
- Updated dependencies [8931cb3]
  - @x402/core@2.7.0

## 2.6.0

### Minor Changes

- Updated dependencies
  - @x402/core@2.6.0

## 2.5.0

### Minor Changes

- 7fe268f: Implemented the erc20 approval gas sponsorship extension

### Patch Changes

- 1ab1c86: Guard against undefined `resource` in SIWX settle hook to prevent runtime crash when `PaymentPayload.resource` is absent
- Updated dependencies [96a9db0]
- Updated dependencies [d0a2b11]
- Updated dependencies
  - @x402/core@2.5.0

## 2.4.0

### Minor Changes

- 018181b: Implement EIP-2612 gasless Permit2 approval extension

  - Added `eip2612GasSponsoring` extension types, resource service declaration, and facilitator validation utilities

- 664285e: Add MCP tool discovery support to the bazaar extension system

### Patch Changes

- 3fb55d7: Upgraded facilitator extension registration from string keys to FacilitatorExtension objects. Added FacilitatorContext threaded through SchemeNetworkFacilitator.verify/settle for mechanism access to extension capabilities
- Updated dependencies [57a5488]
- Updated dependencies [018181b]
- Updated dependencies [3fb55d7]
  - @x402/core@2.4.0

## 2.3.1

### Patch Changes

- f93fc09: Added solanakit support for siwx
- Updated dependencies [9ec9f15]
  - @x402/core@2.3.1

## 2.3.0

### Minor Changes

- fe42994: Added Sign-In-With-X (SIWX) extension for wallet-based authentication. Clients can prove previous payment by signing a message, avoiding re-payment. Supports EVM and Solana signature schemes with multi-chain support, lifecycle hooks for servers and clients, and optional nonce tracking for replay protection.
- 51b8445: Added payment-identifier extension for tracking and validating payment identifiers

### Patch Changes

- Updated dependencies [51b8445]
- Updated dependencies [51b8445]
  - @x402/core@2.3.0

## 2.0.0

- Implements x402 2.0.0 for the TypeScript SDK.

## 1.0.0

- Implements x402 1.0.0 for the TypeScript SDK.
