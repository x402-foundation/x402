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

The facilitator needs only its participant. Verify proves the transfer factory,
the direct delivery to the merchant and the payer's input holdings from the
input contracts carried in the signed transaction, which the ledger
authenticates when it executes; it reads no Scan or registry.

The facilitator signer reads the payer's signing keys from the participant's
JSON Ledger API JOSE route (Canton 3.5.10+). A Splice-distributed participant
does not serve that route: pass `fetchPayerSigningKey` to
`toFacilitatorCantonSigner` with a topology reader (or an admin-API read)
instead. An empty answer refuses the payment.

```ts
import { toClientCantonSigner, toFacilitatorCantonSigner } from "@x402/canton";

const clientCantonSigner = toClientCantonSigner({
  participantUrl: process.env.CANTON_PARTICIPANT_URL!,
  token: process.env.CANTON_TOKEN!,          // static bearer or a resolver
  userId: process.env.CANTON_USER_ID!,
  synchronizerId: process.env.CANTON_SYNCHRONIZER_ID!,
  scanUrl: process.env.CANTON_SCAN_URL!,      // SV Scan: resolves the transfer factory
  // scanToken: "…",                         // only for a gated Scan; the ledger token is never sent to Scan
  party: process.env.CLIENT_CANTON_PARTY!,
  privateKeyPem: process.env.CLIENT_CANTON_PRIVATE_KEY!,
});

const facilitatorCantonSigner = toFacilitatorCantonSigner({
  participantUrl: process.env.CANTON_PARTICIPANT_URL!,
  token: process.env.CANTON_TOKEN!,
  userId: process.env.CANTON_USER_ID!,
  synchronizerId: process.env.CANTON_SYNCHRONIZER_ID!,
  facilitatorParties: [process.env.CANTON_FACILITATOR_PARTY!],
});
```

## Roles

Each role is registered onto the corresponding `@x402/core` instance.

```ts
// Client (payer)
import { x402Client } from "@x402/core/client";
import { ExactCantonScheme } from "@x402/canton/exact/client";

const client = new x402Client().register("canton:*", new ExactCantonScheme(clientCantonSigner));

// Resource server (merchant)
import { x402ResourceServer } from "@x402/core/server";
import { ExactCantonScheme } from "@x402/canton/exact/server";

server.register("canton:*", new ExactCantonScheme());

// Facilitator
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactCantonScheme } from "@x402/canton/exact/facilitator";

facilitator.register(
  "canton:mainnet",
  new ExactCantonScheme(facilitatorCantonSigner, {
    networks: ["canton:mainnet"], // required: the networks this facilitator settles on
    synchronizerId: "global-domain::1220…",
  }),
);
```

Both payment flows are supported: `authorization` (verify, then settle after the
handler) and `upfront` (settle before the handler; set `paymentFlow: "upfront"`
in the route's `extra`).

## Settlement

Settle succeeds once the transaction is committed and returns its `updateId`.
If the participant accepted the transaction but its outcome could not be read,
settle returns the non-terminal `settlement_pending`, with the prepared
transaction's hash as `transaction`, and remembers the submission in a
`PendingSettlementStore`. A retry of the same payload looks the submission up
instead of relaying it again. The transaction cannot commit after its
`executeBefore` plus the synchronizer's ledger-time tolerance, so once that has
passed a submission that is still not on the ledger is reported as failed. That
absence is only provable on a participant that hosts the payer, and never after
the participant reported the relay as a duplicate of an earlier one; otherwise
the answer stays `settlement_pending`. A committed settlement is remembered too,
so a retry after a lost response gets the same `updateId`.

The default store is in-memory, per process, with a 5-minute TTL. A facilitator
running several replicas should pass a shared store as `pendingSettlementStore`,
and one serving long `executeBefore` windows should keep entries at least until
the deadline plus `ledgerTimeToleranceMs` (default 120000).

## Merchant setup

A merchant can be paid only while it holds a live Canton Coin
`TransferPreapproval` (spec: Merchant Onboarding); without one, verification
refuses the payment. `ensureTransferPreapproval` creates it for a merchant that
is an external party, or renews it when it expires within `renewWithinMs`
(default 7 days). The merchant signs with its own key and pays the small
preapproval fee from its own Canton Coin.

```ts
import { ensureTransferPreapproval } from "@x402/canton";

await ensureTransferPreapproval(
  {
    participantUrl: process.env.CANTON_PARTICIPANT_URL!,
    token: process.env.CANTON_TOKEN!,
    userId: process.env.CANTON_USER_ID!,
    synchronizerId: process.env.CANTON_SYNCHRONIZER_ID!,
    scanUrl: process.env.CANTON_SCAN_URL!,
    party: process.env.CANTON_ADDRESS!,
    privateKeyPem: process.env.CANTON_PRIVATE_KEY!,
  },
  { expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) },
);
```

Run it once before serving and again before the preapproval expires; it does
nothing while the preapproval is far from expiry. The e2e suite runs it as
`pnpm canton:setup` and the advanced server example as
`pnpm setup:canton-preapproval`. A registry token's preapproval is created with
its registrar (the DA Registry Utility), not with this helper.

On DevNet, fund the merchant from a
[CC tap](https://docs.canton.network/sdks-tools/sdks/wallet-sdk/guides/performing-a-cc-tap).

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

A non-Amulet token names its registrar as `instrumentId.admin` and `asset` is the
token's symbol. A facilitator settles a registrar's token only when the
registrar is listed in `registryTrustedParties`, mapped to the registry
infrastructure parties that appear in its transfers (the DA Registry Utility
operator and, for a bridged token, the bridge operator):

```ts
new ExactCantonScheme(facilitatorCantonSigner, {
  networks: ["canton:mainnet"],
  registryTrustedParties: { "<registrar>::1220…": ["<operator>::1220…", "<provider>::1220…"] },
});
```

The client resolves a registry token's factory on the registrar's DA Registry
Utility, configured per registrar with the client signer's `tokenRegistries`.

## Testing

```bash
pnpm build
pnpm test              # unit (verify-before-sign on real MainNet fixtures, server)
pnpm test:integration  # client → server → facilitator, stubbed signers
```
