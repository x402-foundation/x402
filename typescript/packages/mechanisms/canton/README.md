# @x402/canton

x402 Payment Protocol — **Canton Network** implementation of the `exact` scheme.

Implements the spec at
[`specs/schemes/exact/scheme_exact_canton.md`](../../../../specs/schemes/exact/scheme_exact_canton.md):
the payer signs a CIP-56 Token Standard `TransferFactory_Transfer` and carries it
**inline** in the payment payload, so any facilitator can relay it in a single
transaction. Canton Coin and any CIP-56 registry token (e.g. USDCx) share the
exact wire shape and differ only by `extra.instrumentId.admin`.

## Design

The package carries the **protocol logic** — the inline-payload codec and the
verify-before-sign / prepared-transaction decoder — and ships **concrete
ledger-backed signers**, `toClientCantonSigner` / `toFacilitatorCantonSigner`,
built on a bundled JSON Ledger API + Scan client and the official
`@canton-network/core-tx-visualizer` hashing (the same code the Canton wallet
ecosystem signs with). They implement the `ClientCantonSigner` /
`FacilitatorCantonSigner` interfaces (mirroring the SVM mechanism's signer
split); an integrator may inject their own implementation instead. Operational
concerns of a facilitator deployment (rate limits, attribution, traffic
accounting) live in the facilitator, not here.

```ts
import { toFacilitatorCantonSigner } from "@x402/canton";

const facilitatorCantonSigner = toFacilitatorCantonSigner({
  participantUrl: process.env.CANTON_PARTICIPANT_URL!,
  token: process.env.CANTON_TOKEN!,          // static bearer or a resolver
  userId: process.env.CANTON_USER_ID!,
  synchronizerId: process.env.CANTON_SYNCHRONIZER_ID!,
  scanUrl: process.env.CANTON_SCAN_URL!,
  facilitatorParties: [process.env.CANTON_FACILITATOR_PARTY!],
});
```

## Roles

Each role is registered onto the corresponding `@x402/core` instance.

```ts
// Client (payer)
import { x402Client } from "@x402/core/client";
import { registerExactCantonScheme } from "@x402/canton/exact/client";

registerExactCantonScheme(client, { signer: clientCantonSigner });

// Resource server (merchant)
import { x402ResourceServer } from "@x402/core/server";
import { registerExactCantonScheme } from "@x402/canton/exact/server";

registerExactCantonScheme(server);

// Facilitator
import { x402Facilitator } from "@x402/core/facilitator";
import { registerExactCantonScheme } from "@x402/canton/exact/facilitator";

registerExactCantonScheme(facilitator, {
  signer: facilitatorCantonSigner,
  synchronizerId: "global-domain::1220…",
  networks: "canton:mainnet",
});
```

## Payment requirements (`extra`)

```jsonc
{
  "scheme": "exact",
  "network": "canton:mainnet",
  "amount": "100000000",          // atomic units (1 CC = 1e10)
  "asset": "CC",                  // or a registry token symbol
  "payTo": "merchant::1220…",
  "extra": {
    "assetTransferMethod": "transfer-factory",
    "feePayer": "facilitator::1220…",     // filled by the facilitator's /supported
    "synchronizerId": "global-domain::1220…",
    "instrumentId": { "admin": "DSO::1220…", "id": "Amulet" },
    "executeBeforeSeconds": 120,
    "memo": "invoice-2024-001"            // optional; enforced when set
  }
}
```

The **inline payload** carries `preparedTransaction` (base64 gzip of the signed
`TransferFactory_Transfer`), `preparedTxHash` (hex), `signature` (base64 ed25519
over the hash) and `hashingSchemeVersion`.

## CIP-56 registry tokens

A non-Amulet token names its registrar as `instrumentId.admin`. Its
`TransferFactory_Transfer` also names the DA Registry Utility operator (and, for
a bridged token, the bridge operator) as signatories/observers; pass those
out-of-band-trusted infra parties via `CantonSchemeConfig.registryTrustedParties`
(and the registrar's utility base URL via `tokenRegistries`). Registry support
is a superset of Canton Coin and is gated on the corresponding spec amendment.

## Testing

```bash
pnpm build
pnpm test              # unit (verify-before-sign on real MainNet fixtures, server)
pnpm test:integration  # client → server → facilitator, stubbed signers
```
