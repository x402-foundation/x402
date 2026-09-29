# @x402/near

NEAR Protocol mechanism for the x402 payment protocol (v2).

This package implements the `exact` scheme on NEAR as specified in
[`specs/schemes/exact/scheme_exact_near.md`](../../../../specs/schemes/exact/scheme_exact_near.md).
A client signs a NEP-366 `SignedDelegate` authorizing exactly one NEP-141
`ft_transfer`, and a facilitator-selected relayer sponsors the onchain
transaction so the payer needs no NEAR for gas.

Supported networks: `near:mainnet`, `near:testnet`.

## Install

```bash
pnpm add @x402/near @x402/core
```

## Client

```ts
import { x402Client } from "@x402/core/client";
import { createClientNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/client";

const signer = createClientNearSigner({
  accountId: "alice.testnet",
  secretKey: "ed25519:...", // full-access key
});

const client = new x402Client();
client.register("near:*", new ExactNearScheme(signer));
```

## Resource server

```ts
import { x402ResourceServer } from "@x402/core/server";
import { ExactNearScheme } from "@x402/near/exact/server";

const server = new x402ResourceServer();
server.register("near:*", new ExactNearScheme());
```

## Facilitator

```ts
import { x402Facilitator } from "@x402/core/facilitator";
import { createFacilitatorNearSigner } from "@x402/near";
import { ExactNearScheme } from "@x402/near/exact/facilitator";

const signer = createFacilitatorNearSigner({
  relayers: [{ accountId: "relayer.testnet", secretKey: "ed25519:..." }],
});

const facilitator = new x402Facilitator();
facilitator.register("near:testnet", new ExactNearScheme(signer));
```

## What verification checks (spec §1–§10)

- Version / scheme / network and requirement consistency (asset, recipient, amount, timeout).
- NEP-366 `SignedDelegate` signature (ed25519 or secp256k1).
- Exactly one `ft_transfer` to `payTo` for the exact `amount`, with `1` yoctoNEAR attached.
- Deterministic `maxTimeoutSeconds → max_block_height` window, and replay protection
  via the onchain access-key nonce (`view_access_key`).
- Full-access key required; standard function-call keys are rejected.
- Chain-state preflight: account existence, deployed token code, `ft_balance_of`,
  and `storage_balance_of` (NEP-145) — failing closed on any RPC error.

Settlement re-verifies, deduplicates concurrent submissions (in-memory cache,
spec §10), submits the delegate action through a relayer, and only reports
`success: true` once the inner `ft_transfer` receipt has succeeded onchain.

## Reference signers

`createClientNearSigner` and `createFacilitatorNearSigner` are JSON-RPC-backed
reference implementations. They accept an optional `rpcUrls` map to override the
default endpoints. You may substitute any implementation of the `ClientNearSigner`
/ `FacilitatorNearSigner` interfaces (e.g. backed by a KMS or a custom relayer).
