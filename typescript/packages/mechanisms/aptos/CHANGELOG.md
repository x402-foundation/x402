# @x402/aptos

## 2.11.0

### Minor Changes

- Updated dependencies [a051f48]
- Updated dependencies [dc04108]
  - @x402/core@2.11.0

## 2.10.0

### Minor Changes

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

- Updated dependencies [f41baed]
- Updated dependencies [aeef1bf]
- Updated dependencies [2564781]
- Updated dependencies [b341973]
- Updated dependencies [29fe09a]
  - @x402/core@2.6.0

## 2.5.0

### Patch Changes

- Updated dependencies [96a9db0]
- Updated dependencies [d0a2b11]
- Updated dependencies
  - @x402/core@2.5.0

## 2.4.0

### Minor Changes

- 57a5488: Add Aptos blockchain support to x402 payment protocol

  - Introduces new `@x402/aptos` package with full client, server, and facilitator scheme implementations
  - Supports exact payment mechanism for Aptos using native APT and fungible assets
  - Includes sponsored transaction support where facilitator pays gas fees
  - Provides `registerExactAptosScheme` helpers for easy client and server integration
  - Adds Aptos network constants for mainnet and testnet
  - Updates core types to support Aptos-specific payment flows

### Patch Changes

- Updated dependencies [57a5488]
- Updated dependencies [018181b]
- Updated dependencies [3fb55d7]
  - @x402/core@2.4.0
