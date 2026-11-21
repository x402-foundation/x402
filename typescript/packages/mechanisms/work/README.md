# `@x402/work`

Profile-defined proof-of-work payments for x402 v2.

The package owns the generic x402 flow. A profile owns the native job,
candidate format, proof function, and source submission. Pool, node RPC,
Stratum, and StratumX connections stay behind the profile.

`amount` is expected profile trials. The package derives the inclusive target
as `floor(2^256 / amount) - 1`; the target is never a second wire field. The
native job is the challenge. A returned solution pays when its score meets the
amount-derived target. Profiles may additionally submit rarer solutions that
meet a native source target.

## Register the server

```ts
import { WorkServerScheme } from "@x402/work/server";

resourceServer.register("quai:9", new WorkServerScheme({ issuers: [profile] }));

const price = {
  amount: "65536",
  asset: "hash",
  extra: { profile: "quai/sha256d-v1" },
};
```

The issuer returns a current, client-visible native job. `job.work` contains
the complete profile-defined mining template, while source credentials and
session state remain private.

## Register the client

```ts
import { WorkClientScheme } from "@x402/work/client";

client.register(
  "quai:9",
  new WorkClientScheme({
    solvers: [profileSolver],
  }),
);
```

The solver receives the native job, derived target, and an `AbortSignal` that
fires at `refreshAfter`, or at `expiresAt` when no earlier refresh is given.

`hash` is not a default asset, so client spend controls reject it until you
allow it. The cap is in expected trials:

```ts
client.setSpendControls({
  allowedAssets: [{ network: "quai:9", asset: "hash", maxAmountPerPayment: "1048576" }],
});
```

## Register the facilitator

```ts
import { WorkFacilitatorScheme } from "@x402/work/facilitator";

facilitator.register(
  "quai:9",
  new WorkFacilitatorScheme({
    profiles: [profile],
    store: durableSharedStore,
  }),
);
```

The store atomically consumes a proof fingerprint and its requirement binding.
Use a durable shared implementation in production.
`InMemoryWorkSettlementStore` is provided for local tests and single-process
examples only.

A facilitator profile fingerprints the canonical job and solution, verifies
the native proof, reward binding, and score.

Verification does not consume or submit work. Settlement atomically consumes
the fingerprint and returns it as the receipt. The provider may then submit a
source-eligible solution through the issuer-owned native session. Native source
acceptance is diagnostic and does not determine whether a payment-valid
solution settles.

See the [work scheme specification](../../../../../specs/schemes/work/scheme_work.md)
for profile and wire requirements.
