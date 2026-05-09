# @x402/paywall Changelog

## 2.11.0

### Minor Changes

- 032295b: fix(paywall): use dynamic token decimals instead of hardcoding 6

  The EVM paywall no longer assumes all tokens have 6 decimal places. Server-side amount conversion in `evmPaywall.generateHtml`:

  - Resolves the token's decimal precision via a new `getDefaultTokenDecimals` helper that looks up the network in `@x402/evm`'s `DEFAULT_STABLECOINS` registry — the same source the scheme `getAssetDecimals` methods read from and the inline scheme dispatch in `@x402/core`'s `x402ResourceServer` uses. Falls back to 6 (USDC default) when the network is unknown.
  - Replaces the lossy `parseFloat(amount) / 10**decimals` math with `Number(formatUnits(BigInt(amount), decimals))`, preserving precision through the atomic-to-display conversion.

  `@x402/evm` now publicly re-exports `DEFAULT_STABLECOINS` from `./shared/defaultAssets` so consumers can read the canonical default-asset registry directly.

### Patch Changes

- 484030b: chore(paywall): regenerate EVM/SVM/AVM bundles for viem 2.47.12

  The bundled paywall templates were last regenerated against a viem version that predates chain definitions for Mezo (`eip155:31612`), Mezo Testnet (`eip155:31611`), MegaETH (`eip155:4326`), MegaETH Testnet (`eip155:6343`), Stable (`eip155:988`), Stable Testnet (`eip155:2201`), Radius (`eip155:723487`), Radius Testnet (`eip155:72344`), and 33 other chains. The lockfile moved to viem 2.47.12 in PR #2013 but the bundle was not regenerated, so @x402/paywall hard-threw `Unsupported chain ID` at component init for payments on those chains.

  This commit regenerates all nine generated files (TypeScript, Python, and Go templates for EVM/SVM/AVM) against the current lockfile. Total unique chain IDs in the EVM bundle goes from 635 to 676.

  No source code changes. Paired with a new PR-time drift check (`.github/workflows/check_paywall_template.yml`) so this stays fresh across future viem bumps.

- Updated dependencies [a051f48]
- Updated dependencies [dc04108]
  - @x402/core@2.11.0

## 2.10.0

### Minor Changes

- a25800e: Add Algorand (AVM) chain support with exact payment scheme and paywall UI

- 9424291: chore: bump viem lockfile to 2.47.12

  Updates the resolved viem version across all direct dependencies, adding chain definitions for Mezo Testnet, MegaETH, Stable, and Stable Testnet that were missing from previously locked versions.

- 37b8347: fix(paywall): read token name from payment requirements instead of hardcoding "USDC"

  The EVM paywall now reads the token name from `extra.name` in payment requirements and uses it for all display text. Falls back to "Token" (generic) when `extra.name` is absent. This fixes mislabeled token names for non-USDC chains (MegaUSD, USDT0, Mezo USD, etc.).

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

- 34d2442: Fixed encoding of characters outside of the Latin1 range
- Updated dependencies [8931cb3]
  - @x402/core@2.7.0

## 2.6.0

### Minor Changes

- 29fe09a: Make ResourceInfo.description, ResourceInfo.mimeType, and PaymentPayload.resource optional to match v2 spec
- Updated dependencies [f41baed]
- Updated dependencies [aeef1bf]
- Updated dependencies [2564781]
- Updated dependencies [b341973]
- Updated dependencies [29fe09a]
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

### Minor Changes

- 51b8445: Bumped @x402/core dependency to 2.3.0

### Patch Changes

- Updated dependencies [51b8445]
- Updated dependencies [51b8445]
  - @x402/core@2.3.0

## 2.0.0

- Implements x402 2.0.0 for the TypeScript SDK.

## 1.0.0

- Implements x402 1.0.0 for the TypeScript SDK.
