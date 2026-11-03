# @x402/stellar Changelog

## 2.29.0

### Minor Changes

- [0aee759](https://github.com/x402-foundation/x402/commit/0aee759): Mapped common Stellar simulation failures to exported typed errors with account and asset context. ([#2975](https://github.com/x402-foundation/x402/pull/2975)) - Thanks [@realmehmetali](https://github.com/realmehmetali)!
- Updated dependencies [636f585](https://github.com/x402-foundation/x402/commit/636f585)
- Updated dependencies [76f2f28](https://github.com/x402-foundation/x402/commit/76f2f28)
- Updated dependencies [732c181](https://github.com/x402-foundation/x402/commit/732c181)
- Updated dependencies [8c2b431](https://github.com/x402-foundation/x402/commit/8c2b431)
- Updated dependencies [3525075](https://github.com/x402-foundation/x402/commit/3525075)
- Updated dependencies [e95b066](https://github.com/x402-foundation/x402/commit/e95b066)
- Updated dependencies [3bd3c1d](https://github.com/x402-foundation/x402/commit/3bd3c1d)
- Updated dependencies [bc31d3e](https://github.com/x402-foundation/x402/commit/bc31d3e)
- Updated dependencies [db2c98e](https://github.com/x402-foundation/x402/commit/db2c98e)
- Updated dependencies [7abd80f](https://github.com/x402-foundation/x402/commit/7abd80f)
- Updated dependencies [fa5eb06](https://github.com/x402-foundation/x402/commit/fa5eb06)
- Updated dependencies [3ca54cb](https://github.com/x402-foundation/x402/commit/3ca54cb)
- Updated dependencies [b609bf5](https://github.com/x402-foundation/x402/commit/b609bf5)
- Updated dependencies [8065278](https://github.com/x402-foundation/x402/commit/8065278)
  - @x402/core@2.29.0

### Patch Changes

- [306fd36](https://github.com/x402-foundation/x402/commit/306fd36): Propagate `invalidMessage` from the settle-time re-verification into `SettleResponse.errorMessage`, including the EVM auth-capture collect and lifecycle settle paths, matching the behavior already present in the avm, casper, cardano, hedera, tvm, and xrpl mechanisms. Settle failures previously returned only `errorReason`, so the diagnostic detail (e.g. the underlying Solana simulation error) was dropped even though `/verify` returned it. ([#3119](https://github.com/x402-foundation/x402/pull/3119)) - Thanks [@notorious-d-e-v](https://github.com/notorious-d-e-v)!
- [62fc03e](https://github.com/x402-foundation/x402/commit/62fc03e): Require `@stellar/stellar-sdk` `^16.4.1`, the `lts-16` release that bumps `axios` from 1.18.0 to 1.20.0 and clears its seven high-severity advisories. No source change: 16.4.1 differs from 16.3.1 by that one dependency, and `.switch()` / `toXDR()` / `fromXDR()` are unchanged on the 16 line. The floor is raised so no install can resolve 16.3.x again. ([#3904](https://github.com/x402-foundation/x402/pull/3904)) - Thanks [@parthod0x](https://github.com/parthod0x)!
- [332f65d](https://github.com/x402-foundation/x402/commit/332f65d): Fixed `ExactStellarScheme.settle` collapsing every non-`PENDING` `sendTransaction` result into the same constant `errorReason`. The RPC's `status`, `errorResult` code, and `latestLedger` are now surfaced via `errorMessage`/`extra`, and a `TRY_AGAIN_LATER` response is reported with a distinct, retryable `errorReason` (`settle_exact_stellar_transaction_submission_retryable`) instead of being treated as a terminal failure identical to `ERROR`. ([#3293](https://github.com/x402-foundation/x402/pull/3293)) - Thanks [@wakqasahmed](https://github.com/wakqasahmed)!

## 2.28.0

### Minor Changes

- Updated dependencies
  - @x402/core@2.28.0

## 2.27.0

### Minor Changes

- [c8c71f2](https://github.com/x402-foundation/x402/commit/c8c71f2): The Stellar exact facilitator accepts an `inclusionFeeStroops` option for the settlement transaction and the fee bump. It used to always bid the 100-stroop minimum, which mainnet often does not include for Soroban transactions, so settlements could time out after a successful verify. The default stays at 100, and verify counts the configured bid against `maxTransactionFeeStroops`. ([#3503](https://github.com/x402-foundation/x402/pull/3503)) - Thanks [@DiegoPoveda01](https://github.com/DiegoPoveda01) and [@claude](https://github.com/claude)!
- Updated dependencies [5d3a2b2](https://github.com/x402-foundation/x402/commit/5d3a2b2)
  - @x402/core@2.27.0

## 2.26.0

### Minor Changes

- Updated dependencies [76fe973](https://github.com/x402-foundation/x402/commit/76fe973)
  - @x402/core@2.26.0

## 2.25.0

### Minor Changes

- [7488a46](https://github.com/x402-foundation/x402/commit/7488a46): Accept CAP-71 V2 address credentials (`SOROBAN_CREDENTIALS_ADDRESS_V2`) in the facilitator's auth-entry validation and in `gatherAuthEntrySignatureStatus`. Stellar Protocol 28 (testnet 2026-08-27, mainnet vote 2026-09-16) activates the V2 arm on the network, and stellar-sdk v17 clients emit V2-signed auth entries by default (`useUpgradedAuth`/`authV2` default to `true` there); previously the facilitator rejected them (`invalid_exact_stellar_payload_unsupported_credential_type`) and signature-status gathering silently skipped them, so any V2 payment failed verification. Source-account and delegated (`addressWithDelegates`) credentials remain rejected. Also raises the `@stellar/stellar-sdk` floor to `^16.3.0`, the v16 LTS release that backports the Protocol 28 XDR (CAP-83/CAP-85 arms) without v17's breaking XDR API rewrite. ([#3279](https://github.com/x402-foundation/x402/pull/3279)) - Thanks [@jeesunikim](https://github.com/jeesunikim) and [@claude](https://github.com/claude)!
- Updated dependencies [1bc2ae8](https://github.com/x402-foundation/x402/commit/1bc2ae8)
- Updated dependencies [299b9bc](https://github.com/x402-foundation/x402/commit/299b9bc)
- Updated dependencies [bbcb974](https://github.com/x402-foundation/x402/commit/bbcb974)
  - @x402/core@2.25.0

### Patch Changes

- [626df07](https://github.com/x402-foundation/x402/commit/626df07): Extend the Stellar facilitator's safety checks (`unsafe_tx_or_op_source`, `facilitator_is_payer`, `facilitator_in_auth`) to also cover `feeBumpSigner`, not just `signingAddresses`. `feeBumpSigner` is now checked via a separate `facilitatorSafetyAddresses` set rather than merged into `signingAddresses`, since `signerMap`-based signer selection in `settle()` does not expect it there. Fixes #3332. ([#3336](https://github.com/x402-foundation/x402/pull/3336)) - Thanks [@Eras256](https://github.com/Eras256) and [@claude](https://github.com/claude)!

## 2.24.0

### Minor Changes

- [bb46ffc](https://github.com/x402-foundation/x402/commit/bb46ffc): Declare `upfront` payment flow support on Stellar `exact` server schemes. `authorization` remains the default; servers opt in per route via `accepts.extra.paymentFlow`. ([#3240](https://github.com/x402-foundation/x402/pull/3240)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies
  - @x402/core@2.24.0

## 2.23.0

### Minor Changes

- [4f58723](https://github.com/x402-foundation/x402/commit/4f58723): Normalize default assets into `DEFAULT_ASSETS` + `getDefaultAsset` / `findDefaultAsset`, and add client `spendControls`: by default only recognized pegged assets are allowed with a `$1` USD cap; opt into other tokens via `allowedAssets` (list with optional integer atomic `maxAmountPerPayment`, or `true` to allow any); pass `spendControls: false` to disable all spend controls. A non-integer per-asset cap is a config error; a non-integer 402 amount on that path is dropped. `$` settlement overrides throw when `getAssetDecimals` is unknown instead of guessing 6 decimals. ([#3124](https://github.com/x402-foundation/x402/pull/3124)) - Thanks [@phdargen](https://github.com/phdargen)!
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

- Updated dependencies [4453a92](https://github.com/x402-foundation/x402/commit/4453a92)
  - @x402/core@2.20.0

## 2.19.0

### Minor Changes

- [c4d2de6](https://github.com/x402-foundation/x402/commit/c4d2de6): Fixed Stellar exact facilitator settlement to derive fees from settle-time simulation (BASE_FEE + resource fee) instead of the client bid, fixing SDK v16 resource-fee double-counting. ([#2852](https://github.com/x402-foundation/x402/pull/2852)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies [c72cfee](https://github.com/x402-foundation/x402/commit/c72cfee)
  - @x402/core@2.19.0

## 2.18.0

### Minor Changes

- Updated dependencies [a3ad102](https://github.com/x402-foundation/x402/commit/a3ad102)
  - @x402/core@2.18.0

## 2.17.0

### Minor Changes

- [be91f31](https://github.com/x402-foundation/x402/commit/be91f31): Upgraded Stellar SDK to v16 and preserved extra signer handling when rebuilding settlement transactions. ([#2662](https://github.com/x402-foundation/x402/pull/2662)) - Thanks [@skyc1e](https://github.com/skyc1e)!
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

- c92c0d1: Bump "@stellar/stellar-sdk" dependency and refactor API call for better performance
- Updated dependencies [8931cb3]
  - @x402/core@2.7.0

## 2.6.0

- Implement x402 v2 protocol support for the Stellar mechanism (exact scheme).
