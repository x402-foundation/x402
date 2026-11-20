# `@x402/sui` [![npm version](https://img.shields.io/npm/v/%40x402%2Fsui.svg)](https://www.npmjs.com/package/@x402/sui)

Sui implementation of the x402 `exact` payment scheme. The facilitator accepts any transaction whose effects credit `payTo` with exactly `amount`, so a payment may be funded from an address balance, coins, swaps, or withdrawals.

Supports `sui:mainnet`, `sui:testnet`, and `sui:devnet`.

## Installation

```bash
npm install @x402/sui
# or
pnpm add @x402/sui
```

## Usage

The package exports the `exact` scheme for all three x402 roles under `@x402/sui/exact/{client,server,facilitator}`. Each is registered on the matching core object for the `sui:*` network family.

### Client

```typescript
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { x402Client } from "@x402/core/client";
import { ExactSuiScheme } from "@x402/sui/exact/client";

// Any Sui signer works: Ed25519, Secp256k1, or a wallet-backed signer.
const keypair = Ed25519Keypair.generate();
const client = new x402Client().register("sui:*", new ExactSuiScheme(keypair));
```

On a 402 response the client builds a transaction that calls `balance::send_funds` for the required amount to `payTo`, and signs it. The transaction carries a `ValidDuring` expiration covering the current and next epoch. When the requirements advertise `extra.feePayer`, the sponsor is set as gas owner with an empty gas payment, and the client refuses to sign if the gas budget exceeds the advertised `extra.maxGasBudget`.

Sui USDC is a recognized default asset, so `x402Client` caps each USDC payment at $1 by default (`DEFAULT_MAX_AMOUNT_PER_PAYMENT`). Change the cap, or allow other coin types such as SUI, with the client's `spendControls` option.

### Server

```typescript
import { x402ResourceServer } from "@x402/core/server";
import { ExactSuiScheme } from "@x402/sui/exact/server";

const server = new x402ResourceServer({
  facilitatorUrl: "https://facilitator.example",
}).register("sui:*", new ExactSuiScheme());

// Price resources in USDC ("$0.01") or with an explicit { amount, asset }.
```

### Facilitator

```typescript
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactSuiScheme } from "@x402/sui/exact/facilitator";

const facilitator = new x402Facilitator().register(
  "sui:*",
  new ExactSuiScheme({
    clients: {
      "sui:mainnet": new SuiGrpcClient({ network: "mainnet", baseUrl: "https://my-node:443" }),
    },
  }),
);
```

No key is needed unless the facilitator sponsors gas. Options:

- `clients`: per-network Sui clients (gRPC or GraphQL). Networks without one use the public fullnode over gRPC.
- `feePayer`: a gas sponsor address, advertised as `extra.feePayer`.
- `executeTransaction`: submits facilitator-sponsored payments. Required when `feePayer` is set.
- `maxSponsoredGasBudget`: the gas budget cap for sponsored payments, in MIST, advertised as `extra.maxGasBudget`. Defaults to `10_000_000n` (0.01 SUI).
- `maxSplits`: the most `extra.splits` entries accepted, 0 to 8, advertised as `maxSplits`. Defaults to 0 (no splits). See [Multi-payee splits](#multi-payee-splits).
- `settlementGuard`: settlement deduplication. Defaults to an in-process guard.

The facilitator rejects a transaction without a `ValidDuring` or `Validity` expiration, or one that is not valid in at most two consecutive epochs (`maxEpoch - minEpoch <= 1`). Settlement also requires the current epoch to be inside that window.

When `asset` is SUI and `payTo` is the gas owner, the payment can't match: gas nets into the same balance change, so `payTo` is never credited exactly `amount`.

#### Gas sponsorship

Set `feePayer` to the sponsor's address and supply an `executeTransaction` that adds the sponsor's signature and submits. With the [`@mysten-incubation/sponsor`](https://www.npmjs.com/package/@mysten-incubation/sponsor) SDK:

```typescript
import { createSponsor, defaults, gasBudget } from "@mysten-incubation/sponsor";
import type { SuiExecutor } from "@x402/sui";

const sponsor = createSponsor({
  signer: sponsorKeypair,
  client,
  validate: [defaults(), gasBudget({ max: 10_000_000n })],
});

const executeTransaction: SuiExecutor = ({ transaction, signatures }) =>
  sponsor.signAndExecuteTransaction({ transaction, userSignature: signatures });

new ExactSuiScheme({ feePayer: sponsor.address, executeTransaction });
```

The sponsor address SHOULD be dedicated to paying gas, with no roles or privileges in other contracts, since Move code can read it with `tx_context::sponsor()`.

> **Note:** passing `validate` replaces the sponsor's default validators. Keep `defaults()` in the list unless you mean to drop those checks.

The executor is used only for payments whose gas owner is `feePayer` and not the sender. Their payload carries only the payer's signature; the executor adds the sponsor's. Other payments are submitted directly. Before co-signing, the facilitator runs the sponsorship checks:

- The gas payment must be empty, so gas comes from the sponsor's address balance.
- The gas budget must not exceed `maxSponsoredGasBudget`.
- No command may use the gas coin.
- No input may withdraw funds from the sponsor, directly or through an allowance it funds.

A failed check returns `invalid_exact_sui_payload_sponsorship_rejected`, and a rejection from the executor itself returns `sponsor_rejected`.

A sponsored transaction that fails because the payer's address balance can't cover the withdrawal does not run and is not charged gas. One that aborts during execution costs up to its signed budget, which the budget cap and the sponsor's rate limiting bound.

Per-sender rate limiting is left to the executor or sponsor.

#### Settlement deduplication

Re-submitting an executed Sui transaction returns its original result, so the facilitator claims each transaction digest before submitting. A second settle of the same transaction fails with `duplicate_settlement`. The claim is released if settlement fails. If it succeeds, the claim is kept for as long as the `SettlementGuard` documentation requires. If the outcome can't be determined, settlement fails with the digest in `transaction` so the caller can reconcile.

A single facilitator process may keep its claims in memory, which is what the default in-process guard does. If the process restarts and forgets its claims, `verify` still rejects a payment that already executed (`invalid_exact_sui_payload_already_executed`), and the standard resource server flow verifies before it settles. When several processes serve `/settle`, they must share one claim store with atomic claims, for example Redis with `SET NX`. A durable store is also worth it when `settle` can be called without `verify`:

```typescript
import type { SettlementGuard } from "@x402/sui";

// Covers the retention SettlementGuard requires; mainnet epochs last about
// 24 hours, so four days leaves room to spare.
const CLAIM_TTL_SECONDS = 4 * 24 * 60 * 60;

const settlementGuard: SettlementGuard = {
  async claim({ network, digest }) {
    const set = await redis.set(`x402:sui:${network}:${digest}`, "1", {
      NX: true,
      EX: CLAIM_TTL_SECONDS,
    });
    return set !== null;
  },
  async release({ network, digest }) {
    await redis.del(`x402:sui:${network}:${digest}`);
  },
};
```

## Multi-payee splits

One payment can pay `payTo` and up to 8 other recipients in a single transaction, as specified in [scheme_exact_sui.md](../../../../specs/schemes/exact/scheme_exact_sui.md#splits). The server lists each split with an absolute amount in the route's `extra`. `amount` stays the total the payer pays, and `payTo` receives the remainder.

```typescript
price: {
  amount: "1050000",
  asset: USDC_MAINNET,
  extra: { splits: [{ payTo: platformAddress, amount: "50000", memo: "platform fee" }] },
},
```

- **Facilitator**: splits are off by default. Pass `maxSplits` (1 to 8) to accept them; it is advertised in `/supported` whether or not the facilitator sponsors gas. Verification checks that `payTo` nets exactly the remainder and each split recipient exactly its amount. Bad splits return `invalid_payment_requirements`.
- **Server**: `enhancePaymentRequirements` throws when the splits break the rules or exceed the facilitator's advertised `maxSplits`.
- **Client**: requirements with splits are refused unless the client options set `approveSplits`, which receives every split and the remainder reaching `payTo`, and must return `true` only for terms the payer agreed to. The client builds one `balance::send_funds` per recipient.

```typescript
new ExactSuiScheme(keypair, {
  approveSplits: splits => splits.every(split => trustedRecipients.has(split.payTo)),
});
```

Recipients must be distinct. Balance changes are netted per address, so a split cannot go to the payer, or to the gas owner when `asset` is SUI. A split payment stays eligible for gasless execution when every share, the remainder included, meets the network minimum ($0.01 for USDC on mainnet).

## Testnet Resources

- **Test SUI**: https://faucet.sui.io/
- **Test USDC**: https://faucet.circle.com/

## License

Apache-2.0
