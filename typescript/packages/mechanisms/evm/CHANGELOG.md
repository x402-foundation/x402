# @x402/evm Changelog

## 2.11.0

### Minor Changes

- 032295b: fix(paywall): use dynamic token decimals instead of hardcoding 6

  The EVM paywall no longer assumes all tokens have 6 decimal places. Server-side amount conversion in `evmPaywall.generateHtml`:

  - Resolves the token's decimal precision via a new `getDefaultTokenDecimals` helper that looks up the network in `@x402/evm`'s `DEFAULT_STABLECOINS` registry — the same source the scheme `getAssetDecimals` methods read from and the inline scheme dispatch in `@x402/core`'s `x402ResourceServer` uses. Falls back to 6 (USDC default) when the network is unknown.
  - Replaces the lossy `parseFloat(amount) / 10**decimals` math with `Number(formatUnits(BigInt(amount), decimals))`, preserving precision through the atomic-to-display conversion.

  `@x402/evm` now publicly re-exports `DEFAULT_STABLECOINS` from `./shared/defaultAssets` so consumers can read the canonical default-asset registry directly.

### Patch Changes

- dc04108: Fixed a bug affecting USD prices with 7+ decimal places of precision (e.g. `$0.0000001` or smaller).
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

- 8c80edd: Add Polygon mainnet (chain ID 137) support with USDC as the default stablecoin
- bbe45f5: Add Stable mainnet (chain ID 988) support with USDT0 as the default stablecoin
- bff876d: Add Stable testnet (chain ID 2201) support with USDT0 as the default stablecoin
- 2250cae: Migrated project from coinbase/x402 to x402-foundation/x402 organization
- d352574: Add upto payment scheme TypeScript SDK with client, facilitator, and server support for permit2-based "up to" payments on EVM chains.

### Patch Changes

- 9f52f9c: Add Arbitrum One (chain ID 42161) and Arbitrum Sepolid (chain ID 421614) support with USDC as the default stablecoin
- 011e680: Add Mezo Testnet (chain ID 31611) support with mUSD as the default stablecoin
- ad2658a: Updated x402UptoPermit2Proxy canonical address to 0x4020A4f3b7b90ccA423B9fabCc0CE57C6C240002, deployed with deterministic bytecode for reproducible cross-chain CREATE2 addresses
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

- 8b731cb: Replaced `sendRawApprovalAndSettle` with a generic `sendTransactions` signer method that accepts an array of pre-signed serialized transactions or unsigned call intents. The signer owns execution strategy (sequential, batched, or atomic bundling). Closed fail-open verification paths, aligned Permit2 amount check to exact match, and added `signerForNetwork` to the extensions package.

### Patch Changes

- d8e9f3f: Added simulation to permit2 verify and (optional) settle
- 1a6e08b: Simulate transaction in verify and (optional) settle; Added multicall utility for efficient rpc calls; Fixed undeployed smart wallet handling to prevent facilitator grieving and account for implementation dependent verifyTypedData
- Updated dependencies [8931cb3]
  - @x402/core@2.7.0

## 2.6.0

### Minor Changes

- f431337: Added assetTransferMethod and supportsEip2612 flag to defaultAssets
- Updated dependencies [f41baed]
- Updated dependencies [aeef1bf]
- Updated dependencies [2564781]
- Updated dependencies [b341973]
- Updated dependencies [29fe09a]
  - @x402/core@2.6.0

## 2.5.0

### Minor Changes

- 7fe268f: Implemented the erc20 approval gas sponsorship extension
- 33a9cab: Update Permit2 witness struct (remove extra field), contract addresses, and error names for post-audit x402 proxy contracts on Base Sepolia

### Patch Changes

- 55a4396: Separated v1 legacy network name resolution from v2 CAIP-2 resolution; getEvmChainId now only accepts eip155:CHAIN_ID format, v1 code uses getEvmChainIdV1 from v1/index
- Updated dependencies [96a9db0]
- Updated dependencies [7fe268f]
- Updated dependencies [1ab1c86]
- Updated dependencies [d0a2b11]
- Updated dependencies
  - @x402/core@2.5.0
  - @x402/extensions@2.5.0

## 2.4.0

### Minor Changes

- 018181b: Implement EIP-2612 gasless Permit2 approval extension

  - Implemented EIP-2612 gas sponsoring for the exact EVM scheme — clients automatically sign EIP-2612 permits when Permit2 allowance is insufficient, and facilitators route to `settleWithPermit` when the extension is present

### Patch Changes

- Updated dependencies [57a5488]
- Updated dependencies [018181b]
- Updated dependencies [3fb55d7]
  - @x402/core@2.4.0
  - @x402/extensions@2.4.0

## 2.3.1

### Patch Changes

- 0c6064d: Add MegaETH mainnet (chain ID 4326) support with USDM as the default stablecoin
- Updated dependencies [9ec9f15]
  - @x402/core@2.3.1

## 2.3.0

### Minor Changes

- 51b8445: Bumped @x402/core dependency to 2.3.0
- 51b8445: Upgraded exact evm to support permit2 payments

### Patch Changes

- adb1b55: Improved error messages for insufficient funds. The `invalidMessage` field now includes the required amount, available balance, asset denomination, and actionable guidance when payment fails due to insufficient funds.
- Updated dependencies [51b8445]
- Updated dependencies [51b8445]
  - @x402/core@2.3.0

## 2.0.0

- Implements x402 2.0.0 for the TypeScript SDK.

## 1.0.0

- Implements x402 1.0.0 for the TypeScript SDK.
