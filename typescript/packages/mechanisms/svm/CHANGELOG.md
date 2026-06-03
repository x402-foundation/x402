# @x402/svm Changelog

## 2.14.0

### Minor Changes

- ba2eb68: Added simulation-based smart wallet verification (Path 2) to the SVM exact facilitator. When `enableSmartWalletVerification` is set, transactions that the static positional path rejects (smart-wallet-wrapped layouts, extra instructions) are re-verified by simulating the transaction and inspecting CPI inner instructions for a matching `TransferChecked` — so a facilitator can accept payments from any allowlisted smart-wallet program (Squads, Swig, SPL Governance, Metaplex Core, Lighthouse) without a per-wallet parser. Includes fee-payer isolation with Address Lookup Table resolution, operator-configurable compute-budget caps, post-settlement transfer verification (TOCTOU defense), and seller-required memo enforcement at parity with the static path. The static path's instruction-count ceiling was raised from 6 to 7 so wallets that inject multiple Lighthouse assertions (e.g. Phantom) verify without falling back to simulation.
- 3ba526c: Fixed SVM exact facilitator deduplication to key on the transaction message hash rather than the full signed-transaction bytes, preventing an attacker from bypassing the cache by randomizing the mutable fee-payer signature slot.
- 588e038: Fixed a security issue in the SVM exact facilitator where the compute unit price cap was silently bypassed. `verifyComputePriceInstruction` read `parsedInstruction.microLamports` (always `undefined`) instead of the correct `parsedInstruction.data.microLamports`, causing the comparison against the 5 µLamport/CU maximum to always evaluate to false. An attacker could include an arbitrarily large `SetComputeUnitPrice` instruction and the facilitator would sign as fee payer, paying the inflated priority fee.
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

- 077b294: Add optional `extra.memo` support to SVM exact scheme. When a seller provides `extra.memo` in PaymentRequirements, the client uses it as the Memo instruction data instead of a random nonce, and the facilitator verifies the memo content matches. Enables payment reconciliation without unique deposit addresses.

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

- 7cd93d8: Add in-memory SettlementCache to prevent duplicate SVM transaction settlement during on-chain confirmation window
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
- bd01572: Added memo instruction with random nonce to SVM transactions to ensure uniqueness and prevent duplicate transaction attacks when multiple payments occur within the same Solana slot

### Patch Changes

- Updated dependencies [51b8445]
- Updated dependencies [51b8445]
  - @x402/core@2.3.0

## 2.0.0

- Implements x402 2.0.0 for the TypeScript SDK.

## 1.0.0

- Implements x402 1.0.0 for the TypeScript SDK.
