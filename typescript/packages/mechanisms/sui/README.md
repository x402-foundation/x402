# `@x402/sui` [![npm version](https://img.shields.io/npm/v/%40x402%2Fsui.svg)](https://www.npmjs.com/package/@x402/sui)

Sui implementation of the x402 `exact` payment scheme. The facilitator accepts any transaction whose effects credit `payTo` with exactly `amount`, so a payment may be funded from an address balance, coins, swaps, or withdrawals.

Verification simulates the signed bytes with transaction checks enabled and gas selection disabled. It rejects simulations that use mocked gas, including for sponsored payments. The gas owner's funds must cover gas in addition to the transaction's withdrawals; a simulated recipient credit funded by a mock gas coin is not a valid payment.

Supports `sui:mainnet`, `sui:testnet`, and `sui:devnet`.

## Installation

```bash
npm install @x402/sui
# or
pnpm add @x402/sui
```

## Usage

The package exports the `exact` scheme for all three x402 roles under `@x402/sui/exact/{client,server,facilitator}`. Each is registered on the matching core object: clients and resource servers can register the `sui:*` network family, and a facilitator registers the concrete networks it serves.

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

The client funds each payment with `tx.balance`, which draws on the address balance first and then on coin objects. Coin selection, including the payer's own gas coin, is per transaction, so two payments built at the same time from the same signer can pick the same coin objects, and at least one of them fails to settle. Payments from one signer can only run concurrently when they use no coin objects at all: paid from the address balance, with gas sponsored by the facilitator or a gasless transfer. Otherwise, build and send them one at a time.

Sui USDC is a recognized default asset, so `x402Client` caps each USDC payment at $1 by default (`DEFAULT_MAX_AMOUNT_PER_PAYMENT`). Change the cap, or allow other coin types such as SUI, with the client's `spendControls` option.

### Server

```typescript
import { HTTPFacilitatorClient, x402ResourceServer } from "@x402/core/server";
import { ExactSuiScheme } from "@x402/sui/exact/server";

const server = new x402ResourceServer(
  new HTTPFacilitatorClient({ url: "https://facilitator.example" }),
).register("sui:*", new ExactSuiScheme());

// Price resources in USDC ("$0.01") or with an explicit { amount, asset }.
```

### Facilitator

```typescript
import { SuiGrpcClient } from "@mysten/sui/grpc";
import { x402Facilitator } from "@x402/core/facilitator";
import { ExactSuiScheme } from "@x402/sui/exact/facilitator";

// Register concrete networks: `/supported` lists them as registered, and resource
// servers match requirements against them exactly.
const facilitator = new x402Facilitator().register(
  ["sui:mainnet", "sui:testnet", "sui:devnet"],
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
- `settlementGuard`: the settlement dedup store. Defaults to an in-memory store that is lost on restart and not shared across processes. See [Settlement deduplication](#settlement-deduplication).

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

Re-submitting an executed Sui transaction returns its original result, so the facilitator claims each transaction digest before submitting. A second settle of the same transaction fails with `duplicate_settlement`. The claim is released if settlement fails, and kept for as long as the `SettlementGuard` documentation requires if it succeeds.

A claim covers only this facilitator's settlements, and settle can't assume a verify ran (the `upfront` flow), so settle also looks the digest up before submitting and rejects a transaction that already executed elsewhere with `invalid_exact_sui_payload_already_executed`.

If the outcome of a submission can't be established, settlement returns `settlement_pending` with the digest in `transaction`, so the caller can reconcile on chain before retrying. The claim is then marked pending rather than released, so a retry of the same signed transaction is recognized as this facilitator's own: it skips the already-executed check and reports the result if the transaction has since executed. Outside the window, settle refuses it and returns the digest so the caller can look it up.

A sponsored payment's simulated effects are checked before the sponsor co-signs it, so a payment that simulates as not crediting `payTo` with exactly `amount` is rejected without spending the sponsor's gas. Simulation can't guarantee what executes: a transaction can behave differently on chain than in simulation. The gas cap and per-sender rate limiting still bound what the sponsor can lose. If this facilitator verified the same payment against the same requirements within `maxTimeoutSeconds` (capped at 10 minutes), settle reuses that result. Otherwise, for example in the `upfront` flow, it simulates at settle.

By default the facilitator keeps claims in memory, which suits only a single process. Claims are lost on every restart, not only one with payments in flight: until a transaction's window ends (up to two epochs, about 48 hours on mainnet), a payment that already settled can be settled again and reported as a second success. When several processes serve `/settle`, or the facilitator may restart, supply one shared, durable store with atomic claims. A claim held by a process that dies mid-settlement, or whose release fails, blocks that digest until the store expires it, which is after the transaction's window closes; settle returns `duplicate_settlement` meanwhile, so reconcile such a payment by digest. For example, with Redis:

```typescript
import type { SettlementGuard } from "@x402/sui";

// Covers the retention SettlementGuard requires; mainnet epochs last about
// 24 hours, so four days leaves room to spare.
const CLAIM_TTL_SECONDS = 4 * 24 * 60 * 60;

const key = ({ network, digest }: { network: string; digest: string }) =>
  `x402:sui:${network}:${digest}`;

const settlementGuard: SettlementGuard = {
  async claim(k) {
    if (await redis.set(key(k), "1", { NX: true, EX: CLAIM_TTL_SECONDS })) return true;
    // Atomically take a pending mark back, so only one retry proceeds.
    const previous = await redis.set(key(k), "1", { XX: true, KEEPTTL: true, GET: true });
    return previous === "pending" ? "pending" : false;
  },
  async markPending(k) {
    await redis.set(key(k), "pending", { XX: true, KEEPTTL: true });
  },
  async release(k) {
    await redis.del(key(k));
  },
};
```

## Testnet Resources

- **Test SUI**: https://faucet.sui.io/
- **Test USDC**: https://faucet.circle.com/

## License

Apache-2.0
