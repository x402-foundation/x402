# @x402/svm Changelog

## 2.25.0

### Minor Changes

- [299b9bc](https://github.com/x402-foundation/x402/commit/299b9bc): Add an optional facilitator-delegated receiver-authorizer mode to SVM `upto`. The facilitator may advertise `receiverAuthorizer` in `/supported`; a server that omits `receiverAuthorizerSigner` delegates voucher signing, and the facilitator signs after correlating the claim settle to the same authenticated caller that opened the channel. ([#3346](https://github.com/x402-foundation/x402/pull/3346)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies [1bc2ae8](https://github.com/x402-foundation/x402/commit/1bc2ae8)
- Updated dependencies [299b9bc](https://github.com/x402-foundation/x402/commit/299b9bc)
- Updated dependencies [bbcb974](https://github.com/x402-foundation/x402/commit/bbcb974)
  - @x402/core@2.25.0

### Patch Changes

- [fed6a04](https://github.com/x402-foundation/x402/commit/fed6a04): Replace `node:crypto`/`Buffer` usage in `transactionMessageHash`, `getChannelDistributionHash`, and payment-channel account discovery with `@noble/hashes/sha256` and `@solana/kit`'s base64 codec. These SHA-256 call sites were only ever needed by facilitator-side code, but lived in modules also imported by `exact/client`/`upto/client`, pulling Node's `crypto` module (and `Buffer`) into browser bundles of any consumer that imports the SVM client and forcing a `crypto`/`buffer` polyfill (e.g. `vite-plugin-node-polyfills`). `@noble/hashes` is a pure-JS, dependency-free SHA-256 implementation that produces byte-identical digests and needs no platform crypto API or polyfill on any target (browser, Node, React Native). ([#3335](https://github.com/x402-foundation/x402/pull/3335)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe)!

## 2.24.0

### Minor Changes

- [bb46ffc](https://github.com/x402-foundation/x402/commit/bb46ffc): Declare `upfront` payment flow support on SVM `exact` server schemes. `authorization` remains the default; servers opt in per route via `accepts.extra.paymentFlow`. ([#3240](https://github.com/x402-foundation/x402/pull/3240)) - Thanks [@phdargen](https://github.com/phdargen)!
- [01b0a68](https://github.com/x402-foundation/x402/commit/01b0a68): Verify SVM exact payments without a fee-payer signing round trip: required signatures are checked locally, `simulateTransaction` always runs with `sigVerify` off, and `sendTransaction` skips preflight. Settle checks the duplicate cache before verification, decodes the transaction once (including address lookup tables), and smart-wallet settle fetches a single pre-balance. Confirmation polling starts at 250ms. ([#3263](https://github.com/x402-foundation/x402/pull/3263)) - Thanks [@phdargen](https://github.com/phdargen)!
- [acaa904](https://github.com/x402-foundation/x402/commit/acaa904): Route SVM `upto` facilitator RPC through `toFacilitatorSvmSigner` instead of scheme config: claim settlement simulates before `skipPreflight` send, deposit composite sim uses `replaceRecentBlockhash` without an extra blockhash fetch, and claim overlaps channel read with blockhash prefetch. `UptoSvmFacilitatorConfig.rpc` / `rpcUrl` are removed — pass a paced RPC client or `{ defaultRpcUrl }` to the signer factory (#3183). ([#3274](https://github.com/x402-foundation/x402/pull/3274)) - Thanks [@phdargen](https://github.com/phdargen)!

### Patch Changes

- [ec0f71e](https://github.com/x402-foundation/x402/commit/ec0f71e): Reject invalid smart-wallet compute-unit and priority-fee limits when smart-wallet verification is enabled or its exported verification helpers are called, preventing non-finite or fractional configuration values from silently disabling fee protections or causing misleading payment failures. Export `assertSmartWalletLimits` and `SmartWalletLimits` for pre-validation. Dormant limits remain ignored while smart-wallet verification is disabled. ([#3122](https://github.com/x402-foundation/x402/pull/3122)) - Thanks [@notorious-d-e-v](https://github.com/notorious-d-e-v)!
  - @x402/core@2.24.0

## 2.23.0

### Minor Changes

- [4f58723](https://github.com/x402-foundation/x402/commit/4f58723): Normalize default assets into `DEFAULT_ASSETS` + `getDefaultAsset` / `findDefaultAsset`, and add client `spendControls`: by default only recognized pegged assets are allowed with a `$1` USD cap; opt into other tokens via `allowedAssets` (list with optional integer atomic `maxAmountPerPayment`, or `true` to allow any); pass `spendControls: false` to disable all spend controls. A non-integer per-asset cap is a config error; a non-integer 402 amount on that path is dropped. `$` settlement overrides throw when `getAssetDecimals` is unknown instead of guessing 6 decimals. Register helpers scope v1 networks to `config.networks`. ([#3124](https://github.com/x402-foundation/x402/pull/3124)) - Thanks [@phdargen](https://github.com/phdargen)!
- [167a828](https://github.com/x402-foundation/x402/commit/167a828): Add ComputeBudget instructions to SVM `upto` transactions. The channel open prefixes `SetComputeUnitLimit` (default 90,000 CU, spec ceiling 400,000) and `SetComputeUnitPrice` (default 1 microlamport/CU); the open builder treats an explicit `0` as "omit the instruction and let a wallet inject its own". Facilitator-submitted settlement transactions use static limits: claim / zero-charge cancel / rent-cleanup close and distribute default to 100,000 CU (operator-overridable via `settleComputeUnitLimit` on `UptoSvmFacilitatorConfig` / `UptoSvmRentCleanupManagerConfig`), and reclaim batches are sized per channel (25,000 + 5,000 x batch size). A configurable `SetComputeUnitPrice` is attached to facilitator transactions (`computeUnitPriceMicroLamports`, default 1). Defaults assume standard SPL Token settlement; compute-heavy Token-2022 extension mints (e.g. transfer hooks) require explicit overrides. Previously `upto` transactions carried no ComputeBudget instructions, so the runtime reserved 400,000-403,000 CU per transaction (SIMD-0170 defaults) while consuming ~2-50k, inflating block/account cost accounting and making priority fees ~10x more expensive per unit of actual priority. ([#3155](https://github.com/x402-foundation/x402/pull/3155)) - Thanks [@notorious-d-e-v](https://github.com/notorious-d-e-v)!
- [2a706b2](https://github.com/x402-foundation/x402/commit/2a706b2): Split the SVM `upto` rent cleanup manager into two runners and make shutdown wait. Onchain discovery is no longer a branch inside a cleanup pass: `enableDiscovery` is replaced by a public `discover()` and a `discoveryIntervalSecs` on `start()`, so the `getProgramAccounts` sweep can run daily while cleanup keeps its short interval. Discovered Distributed channels are written into channel storage (never overwriting a tracked record) for a later cleanup pass to reclaim. `stop()` now returns a promise: it aborts the run and waits for the in-flight pass rather than leaving a broadcast settle orphaned, and `RentCleanupOptions` accepts a caller `signal`. `maxTxsPerRun` now only bounds the storage scan; the per-rent-payer reclaim budget moved to a separate `maxTxsPerSigner` (both default to 20), so a large reclaim backlog no longer starves the scan. The scan sorts by channel id before applying its resume cursor, making the cursor stable across storage implementations that do not preserve insertion order. `ClientSvmConfig` no longer takes `computeUnitLimit` / `computeUnitPriceMicroLamports`; both schemes' clients use their documented defaults. An empty `extra.memo` is now treated as unset rather than as a required empty memo. ([#3141](https://github.com/x402-foundation/x402/pull/3141)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe) and [@cursoragent](https://github.com/cursoragent), [@claude](https://github.com/claude)!
- [79b6259](https://github.com/x402-foundation/x402/commit/79b6259): Added a usage-based `upto` payment scheme for SVM, backed by an onchain payment-channels program. Resource servers can authorize up to a ceiling and settle the actual metered usage, with client/server/facilitator support, offchain voucher signing, and channel open/distribute/settle helpers. Deposit settle rejects an already-existing channel (`invalid_upto_svm_channel_already_open`) so each authorization opens exactly once. ([#3094](https://github.com/x402-foundation/x402/pull/3094)) - Thanks [@phdargen](https://github.com/phdargen) and [@lgalabru](https://github.com/lgalabru)!
- [656437e](https://github.com/x402-foundation/x402/commit/656437e): Keep public `Money` as `string | number`, but parse and convert internally as decimal strings only. `parseMoney` / `parseMoneyString` return the extracted decimal substring; `MoneyParser` amount is `string | number` (`parsePrice` always passes a string). `convertToTokenAmount` pads/truncates toward zero including to `"0"` instead of throwing on dust. ([#3154](https://github.com/x402-foundation/x402/pull/3154)) - Thanks [@phdargen](https://github.com/phdargen)!
- [8c308ce](https://github.com/x402-foundation/x402/commit/8c308ce): Allow injecting a pre-built RPC client into the SVM `upto` facilitator (`UptoSvmFacilitatorConfig.rpc`, and the rent cleanup manager's config). When provided it is preferred over constructing a client from `rpcUrl`, letting facilitators route channel claim/cleanup sends through their own paced or instrumented transport (e.g. to respect a provider's sendTransaction rate limit). ([#3183](https://github.com/x402-foundation/x402/pull/3183)) - Thanks [@notorious-d-e-v](https://github.com/notorious-d-e-v)!
- Updated dependencies [79b6259](https://github.com/x402-foundation/x402/commit/79b6259)
- Updated dependencies [4f58723](https://github.com/x402-foundation/x402/commit/4f58723)
- Updated dependencies [ab1a31a](https://github.com/x402-foundation/x402/commit/ab1a31a)
- Updated dependencies [c2612d3](https://github.com/x402-foundation/x402/commit/c2612d3)
- Updated dependencies [656437e](https://github.com/x402-foundation/x402/commit/656437e)
  - @x402/core@2.23.0

### Patch Changes

- [16a23d0](https://github.com/x402-foundation/x402/commit/16a23d0): Added validation guard for TransferChecked ([#3132](https://github.com/x402-foundation/x402/pull/3132)) - Thanks [@phdargen](https://github.com/phdargen)!
- [2a706b2](https://github.com/x402-foundation/x402/commit/2a706b2): Harden the SVM `upto` facilitator and rent cleanup manager: - Clamp `maxReclaimsPerTx` (and fall back non-positive values to the default) so a misconfigured operator setting cannot build a reclaim batch that fails to serialize or loops forever. - Guard `BigInt(requirements.amount)` in claim verification so a malformed requirement is reported as a structured failure instead of an uncaught exception. - Distinguish a settlement confirmation timeout (`settlement_confirmation_timeout`) from an onchain rejection (`transaction_failed`) in claim settlement, and keep the dedup cache entry on timeout so a retry cannot race a second `settle_and_seal` against a transaction that may still land. - Remove the unused `simulateZeroChargeSettle` helper. - Reuse `BASIS_POINTS_DENOMINATOR` instead of a duplicated literal in the rent cleanup manager's abandon-close split. ([#3141](https://github.com/x402-foundation/x402/pull/3141)) - Thanks [@CarsonRoscoe](https://github.com/CarsonRoscoe) and [@cursoragent](https://github.com/cursoragent), [@claude](https://github.com/claude)!

## 2.22.0

### Minor Changes

- [db5da2e](https://github.com/x402-foundation/x402/commit/db5da2e): Require ATM-keyed `paymentFlows` (and `defaultAssetTransferMethod`) on every `SchemeNetworkServer`. Core resolves ATM/flow from the table, rejects unsupported combinations, and always signals non-`authorization` `paymentFlow` on the 402 wire. All schemes currently declare `authorization` only. ([#3053](https://github.com/x402-foundation/x402/pull/3053)) - Thanks [@phdargen](https://github.com/phdargen)!
- [927fea8](https://github.com/x402-foundation/x402/commit/927fea8): Add operator-configurable transaction limits to `ExactSvmSchemeOptions` for the static verification path: `maxPriorityFeeMicroLamports` (was hardcoded to `MAX_COMPUTE_UNIT_PRICE_MICROLAMPORTS`), `maxComputeUnits` (previously unbounded), and `maxRequiredSignatures` (previously unchecked). The facilitator pays the transaction fee, so these bound the fee a payer can make it pay. All three default to existing behavior. ([#3120](https://github.com/x402-foundation/x402/pull/3120)) - Thanks [@notorious-d-e-v](https://github.com/notorious-d-e-v)!
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

- [04c94b6](https://github.com/x402-foundation/x402/commit/04c94b6): Added support for resource servers to include recent blockhash hints in SVM exact payment requirements. Clients use valid hints without a blockhash RPC call and fetch their own blockhash when a hint is absent or malformed. ([#2937](https://github.com/x402-foundation/x402/pull/2937)) - Thanks [@phdargen](https://github.com/phdargen)!

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

### Patch Changes

- [f5532b8](https://github.com/x402-foundation/x402/commit/f5532b8): Cache SVM exact client mint metadata to avoid repeated mint RPC fetches. ([#2628](https://github.com/x402-foundation/x402/pull/2628)) - Thanks [@wnjoon](https://github.com/wnjoon)!

## 2.15.0

### Minor Changes

- Updated dependencies [bfa580e](https://github.com/x402-foundation/x402/commit/bfa580e)
- Updated dependencies [3a60816](https://github.com/x402-foundation/x402/commit/3a60816)
- Updated dependencies [7539e93](https://github.com/x402-foundation/x402/commit/7539e93)
  - @x402/core@2.15.0

### Patch Changes

- [5a4b5f3](https://github.com/x402-foundation/x402/commit/5a4b5f3): Fix the default SVM smart wallet allowlist to use Swig's active program ID. ([#2509](https://github.com/x402-foundation/x402/pull/2509)) - Thanks [@edo-chan](https://github.com/edo-chan)!

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
