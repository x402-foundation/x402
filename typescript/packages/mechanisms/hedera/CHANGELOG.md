# Changelog

## 2.18.0

### Minor Changes

- [d00e388](https://github.com/x402-foundation/x402/commit/d00e388): **[Breaking for facilitator implementers]** Hardened the exact Hedera facilitator `verify()` path so it closes the unsigned/wrong-key and unassociated-recipient gaps between verify and settle. (This is not full verify⇒settle parity: paused/frozen/KYC, custom fees, and expiry remain out of scope.) `verify()` now (1) confirms every debited sender actually signed the frozen transaction body — including KeyList/threshold accounts — by reading the payer's onchain account key from the free Hedera Mirror Node REST API, and (2) pre-checks balance and token association for each sender against the Mirror Node (the reliable data source, since consensus-node token data is no longer dependable). Both run unconditionally and fail closed. The whole verify path is now Mirror-Node-only and requires no operator-funded queries. Migration for `FacilitatorHederaSigner` implementers: - `verifyPayerSignature` and `preflightTransfer` are now both required (previously optional/absent). Custom signers will fail to compile until both are wired, and an unwired `verifyPayerSignature` fails closed at runtime by rejecting all payments. - `createHederaVerifyPayerSignature` no longer takes a client factory. Its signature is now `createHederaVerifyPayerSignature(config?: { mirrorNodeUrl?: string })`; it reads the payer key from the Mirror Node instead of a paid `AccountInfoQuery`, so the verify-only operator setup is no longer needed. - `createHederaPreflightTransfer(buildClient)` → `createHederaPreflightTransfer(config?: { mirrorNodeUrl?: string })`. This is a silent change: callers still passing a client factory put a function where a config object is expected, so `mirrorNodeUrl` is `undefined` and it silently falls back to the public Mirror Node. Bumped `@hiero-ledger/sdk` to `2.85.0` and added `@hiero-ledger/proto` `2.31.0` (kept in lockstep, since the SDK pins that proto version). No breaking changes for this package's API surface; the SDK bump is a minor (non-major) version, so the re-exported SDK primitives are unaffected. ([#2707](https://github.com/x402-foundation/x402/pull/2707)) - Thanks [@phdargen](https://github.com/phdargen)!
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

- Align version with the monorepo fixed release group.

## 2.13.2

### Minor Changes

- Updated dependencies [be788e0]
- Updated dependencies [0af31dd]
  - @x402/core@2.14.0

## 2.13.1

### Patch Changes

- Fix `@x402/core` workspace resolution.

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

- Add initial `@x402/hedera` package with x402 v2 exact scheme support.
