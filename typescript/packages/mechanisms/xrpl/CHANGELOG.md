# @x402/xrpl

## 2.25.0

### Minor Changes

- Updated dependencies [1bc2ae8](https://github.com/x402-foundation/x402/commit/1bc2ae8)
- Updated dependencies [299b9bc](https://github.com/x402-foundation/x402/commit/299b9bc)
- Updated dependencies [bbcb974](https://github.com/x402-foundation/x402/commit/bbcb974)
  - @x402/core@2.25.0

## 2.24.0

### Minor Changes

- [bb46ffc](https://github.com/x402-foundation/x402/commit/bb46ffc): Declare `upfront` payment flow support on XRPL `exact` server schemes. `authorization` remains the default; servers opt in per route via `accepts.extra.paymentFlow`. ([#3240](https://github.com/x402-foundation/x402/pull/3240)) - Thanks [@phdargen](https://github.com/phdargen)!
- Updated dependencies
  - @x402/core@2.24.0

## 2.23.0

### Minor Changes

- [4f58723](https://github.com/x402-foundation/x402/commit/4f58723): Normalize default assets into `DEFAULT_ASSETS` + `getDefaultAsset` / `findDefaultAsset`, and add client `spendControls`: by default only recognized pegged assets are allowed with a `$1` USD cap; opt into other tokens via `allowedAssets` (list with optional integer atomic `maxAmountPerPayment`, or `true` to allow any); pass `spendControls: false` to disable all spend controls. A non-integer per-asset cap is a config error; a non-integer 402 amount on that path is dropped. Ship USD default (RLUSD). Pins the RLUSD issuer in the client scheme before signing. `$` settlement overrides throw when `getAssetDecimals` is unknown instead of guessing 6 decimals. ([#3124](https://github.com/x402-foundation/x402/pull/3124)) - Thanks [@phdargen](https://github.com/phdargen)!
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

- [08a3b46](https://github.com/x402-foundation/x402/commit/08a3b46): Added the XRPL `exact` scheme reference implementation (TypeScript), following `specs/schemes/exact/scheme_exact_xrpl.md`. Includes the client scheme (payer-signed XRPL `Payment` transactions with `sequence` and `ticketSequence` asset transfer methods, `InvoiceID` invoice binding, and NetworkID handling per spec section 5), the resource-server scheme (explicit AssetAmount pricing for XRP drops and issued-currency decimal values, `extra.areFeesSponsored: false`, and configured invoice ids), and the facilitator scheme implementing the spec's verification rules (envelope checks per section 1, offline signature validation with signer-to-account authorization per section 10, destination/amount/SendMax validation per sections 4 and 6, per-method account sequencing per section 7, invoice binding per section 8, safety rejections per section 9, and simulation per section 11) with settlement that re-verifies, rejects duplicate submissions through an in-memory `SettlementCache` keyed on the signed transaction hash, submits, and requires a validated `tesSUCCESS` result. Ships a `createTickets` utility for pre-creating XRPL Tickets, reference wallet signer, unit and integration tests, and e2e/example wiring. ([#2801](https://github.com/x402-foundation/x402/pull/2801)) - Thanks [@aristotle-satoshi](https://github.com/aristotle-satoshi)!
