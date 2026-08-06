# @x402/xrpl

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
