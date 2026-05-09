# @x402/hono Changelog

## 2.11.0

### Minor Changes

- Updated dependencies [a051f48]
- Updated dependencies [032295b]
- Updated dependencies [dc04108]
- Updated dependencies [484030b]
  - @x402/core@2.11.0
  - @x402/paywall@2.11.0
  - @x402/extensions@2.11.0

## 2.10.0

### Minor Changes

- Updated dependencies [a25800e]
- Updated dependencies [9424291]
- Updated dependencies [37b8347]
- Updated dependencies [a4e4911]
  - @x402/paywall@2.10.0
  - @x402/extensions@2.10.0
  - @x402/core@2.10.0

## 2.9.0

### Minor Changes

- 2250cae: Migrated project from coinbase/x402 to x402-foundation/x402 organization
- d352574: Add SettlementOverrides support for partial settlement (upto scheme). Route handlers can call setSettlementOverrides() to settle less than the authorized maximum, enabling usage-based billing.

### Patch Changes

- Updated dependencies [8cf3fca]
- Updated dependencies [c0e3969]
- Updated dependencies [2250cae]
- Updated dependencies [d352574]
  - @x402/core@2.9.0
  - @x402/paywall@2.9.0
  - @x402/extensions@2.9.0

## 2.8.0

### Minor Changes

- 4c1e44f: Treat malformed facilitator success payloads as upstream facilitator errors and return 502 responses from framework middleware instead of flattening them into payment failures.
- Updated dependencies [4f2f4f3]
- Updated dependencies [067f297]
- Updated dependencies [067f297]
- Updated dependencies [4c1e44f]
- Updated dependencies [5135fab]
  - @x402/extensions@2.8.0
  - @x402/core@2.8.0
  - @x402/paywall@2.8.0

## 2.7.0

### Minor Changes

- Updated dependencies [34d2442]
- Updated dependencies [8b731cb]
- Updated dependencies [f2bbb5c]
- Updated dependencies [8931cb3]
- Updated dependencies [34d2442]
  - @x402/extensions@2.7.0
  - @x402/core@2.7.0
  - @x402/paywall@2.7.0

## 2.6.0

### Minor Changes

- aeef1bf: Added dynamic function for servers to generate custom response for settlement failures defaulting to empty
- 2564781: Include PAYMENT-RESPONSE header on settlement failure responses
- Updated dependencies [f41baed]
- Updated dependencies [aeef1bf]
- Updated dependencies [2564781]
- Updated dependencies [b341973]
- Updated dependencies [29fe09a]
  - @x402/core@2.6.0
  - @x402/paywall@2.6.0

## 2.5.0

### Minor Changes

- Updated dependencies [96a9db0]
- Updated dependencies [7fe268f]
- Updated dependencies [1ab1c86]
- Updated dependencies [d0a2b11]
- Updated dependencies
  - @x402/core@2.5.0
  - @x402/extensions@2.5.0
  - @x402/paywall@2.4.1

## 2.4.0

### Minor Changes

- Updated dependencies [57a5488]
- Updated dependencies [018181b]
- Updated dependencies [3fb55d7]
  - @x402/core@2.4.0
  - @x402/extensions@2.4.0
  - @x402/paywall@2.4.0

## 2.3.0

### Minor Changes

- 51b8445: Bumped @x402/core dependency to 2.3.0

### Patch Changes

- Updated dependencies [51b8445]
- Updated dependencies [51b8445]
- Updated dependencies [51b8445]
- Updated dependencies [fe42994]
- Updated dependencies [51b8445]
  - @x402/core@2.3.0
  - @x402/paywall@2.3.0
  - @x402/extensions@2.3.0

## 2.0.0

- Implements x402 2.0.0 for the TypeScript SDK.

## 1.0.0

- Implements x402 1.0.0 for the TypeScript SDK.
