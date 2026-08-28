# @x402/avm

## 2.24.0

### Minor Changes

- [bb46ffc](https://github.com/x402-foundation/x402/commit/bb46ffc): Declare `upfront` payment flow support on AVM `exact` server schemes. `authorization` remains the default; servers opt in per route via `accepts.extra.paymentFlow`. ([#3240](https://github.com/x402-foundation/x402/pull/3240)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies
  - @x402/core@2.24.0

## 2.23.0

### Minor Changes

- [4f58723](https://github.com/x402-foundation/x402/commit/4f58723): Normalize default assets into `DEFAULT_ASSETS` + `getDefaultAsset` / `findDefaultAsset`, and add client `spendControls`: by default only recognized pegged assets are allowed with a `$1` USD cap; opt into other tokens via `allowedAssets` (list with optional integer atomic `maxAmountPerPayment`, or `true` to allow any); pass `spendControls: false` to disable all spend controls. A non-integer per-asset cap is a config error; a non-integer 402 amount on that path is dropped. `$` settlement overrides throw when `getAssetDecimals` is unknown instead of guessing 6 decimals. Rename identifier field `asaId` → `asset`. ([#3124](https://github.com/x402-foundation/x402/pull/3124)) - Thanks [@phdargen](https://github.com/phdargen)!
- [656437e](https://github.com/x402-foundation/x402/commit/656437e): Keep public `Money` as `string | number`, but parse and convert internally as decimal strings only. `parseMoney` / `parseMoneyString` return the extracted decimal substring; `MoneyParser` amount is `string | number` (`parsePrice` always passes a string). `convertToTokenAmount` pads/truncates toward zero including to `"0"` instead of throwing on dust. ([#3154](https://github.com/x402-foundation/x402/pull/3154)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies [79b6259](https://github.com/x402-foundation/x402/commit/79b6259)
- Updated dependencies [4f58723](https://github.com/x402-foundation/x402/commit/4f58723)
- Updated dependencies [ab1a31a](https://github.com/x402-foundation/x402/commit/ab1a31a)
- Updated dependencies [c2612d3](https://github.com/x402-foundation/x402/commit/c2612d3)
- Updated dependencies [656437e](https://github.com/x402-foundation/x402/commit/656437e)
  - @x402/core@2.23.0

## 2.22.0

### Minor Changes

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

## 2.20.0

### Minor Changes

- [61349de](https://github.com/x402-foundation/x402/commit/61349de): Adopted CAIP-2-compliant Algorand network identifiers per the Algorand namespace profile. Server registration and constants emit canonical truncated IDs; client and facilitator normalize legacy full-hash IDs on input for backwards compatibility. ([#2931](https://github.com/x402-foundation/x402/pull/2931)) - Thanks [@phdargen](https://github.com/phdargen)!
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

- Updated dependencies [be788e0]
- Updated dependencies [0af31dd]
  - @x402/core@2.14.0

## 2.13.0

### Minor Changes

- Updated dependencies [ad08a9a]
- Updated dependencies [5fca9f3]
- Updated dependencies [95f2094]
- Updated dependencies [49ea054]
  - @x402/core@2.13.0

## 2.12.0

### Minor Changes

- Updated dependencies [608034f]
- Updated dependencies [d235050]
- Updated dependencies [45d7d19]
  - @x402/core@2.12.0

## 2.11.0

### Minor Changes

- dc04108: Fixed a bug affecting USD prices with 7+ decimal places of precision (e.g. `$0.0000001` or smaller).
- Updated dependencies [a051f48]
- Updated dependencies [dc04108]
  - @x402/core@2.11.0

## 2.10.1

### Patch Changes

- Fix `@x402/core` workspace resolution.

## 2.10.0

- Implement x402 v2 protocol support for the Algorand mechanism (exact scheme).
