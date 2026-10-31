# @x402/canton

## 2.29.0

### Minor Changes

- [c5bed45](https://github.com/x402-foundation/x402/commit/c5bed45): Add `@x402/canton` — the Canton Network implementation of the `exact` scheme. The payer signs a CIP-56 Token Standard `TransferFactory_Transfer` and carries it inline in the payment payload (per `specs/schemes/exact/scheme_exact_canton.md`), so any facilitator can relay it in a single transaction. The package provides the client, resource-server, and facilitator scheme classes for `@x402/core`, plus concrete ledger-backed signers (`toClientCantonSigner` / `toFacilitatorCantonSigner`) built on a bundled JSON Ledger API + Scan client and the official `@canton-network/core-tx-visualizer` hashing; an integrator may also inject their own `ClientCantonSigner` / `FacilitatorCantonSigner`. Canton Coin and CIP-56 registry tokens (e.g. USDCx) share the exact wire shape and differ only by `extra.instrumentId.admin`. The facilitator proves the factory, the direct delivery and the payer's inputs from the signed transaction alone, supports the `authorization` and `upfront` flows, and answers `settlement_pending` when a relay's outcome is not yet known. `ensureTransferPreapproval` creates or renews the Canton Coin `TransferPreapproval` a merchant needs to be paid. ([#3242](https://github.com/x402-foundation/x402/pull/3242)) - Thanks [@nicky2pc](https://github.com/nicky2pc)!
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
