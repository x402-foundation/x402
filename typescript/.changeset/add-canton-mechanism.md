---
"@x402/canton": minor
---

Add `@x402/canton` — the Canton Network implementation of the `exact` scheme.

The payer signs a CIP-56 Token Standard `TransferFactory_Transfer` and carries it
inline in the payment payload (per `specs/schemes/exact/scheme_exact_canton.md`),
so any facilitator can relay it in a single transaction. The package provides the
client, resource-server, and facilitator scheme classes for `@x402/core`, plus
concrete ledger-backed signers (`toClientCantonSigner` / `toFacilitatorCantonSigner`)
built on a bundled JSON Ledger API + Scan client and the official
`@canton-network/core-tx-visualizer` hashing; an integrator may also inject their
own `ClientCantonSigner` / `FacilitatorCantonSigner`. Canton Coin and CIP-56
registry tokens (e.g. USDCx) share the exact wire shape and differ only by
`extra.instrumentId.admin`.
