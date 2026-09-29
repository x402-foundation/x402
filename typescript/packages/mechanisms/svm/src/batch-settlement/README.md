# Batch-Settlement SVM Scheme (`@x402/svm/batch-settlement`)

The **batch-settlement** scheme enables high-throughput payments on Solana. The client deposits once into a [payment-channels](https://github.com/solana-foundation/payment-channels) escrow, then pays for many requests without an onchain transaction per call. The resource server verifies each authorization offchain, serves immediately, and redeems accumulated vouchers later through the facilitator.

Two voucher modes share the same channel lifecycle:

| Mode | Who signs vouchers | Per-request wire payload | Typical use |
|------|-------------------|--------------------------|-------------|
| **Client-signed** (default) | Client (`payerAuthorizer`) | Cumulative Ed25519 voucher | Fixed price per request; client retains full voucher authority |
| **Server-signed** | Resource `operator` | Expiring payer proof + request id; operator signs the metered cumulative charge after serving | Usage-based billing without a client signature on every request |

In server mode the channel's onchain `authorized_signer` is the operator, who could claim the full unspent deposit. Clients enter that mode only for operator keys listed in `serverSignedChannelsPolicy`, with escrow capped by `maxDeposit` (default `$1` for default assets). An untrusted server-signed accept is refused; when the same route also offers client-signed, the scheme falls back automatically.

Uses the same payment-channels program as SVM `upto`. `upto` is a one-request channel that closes after one metered charge; **batch-settlement** keeps the channel open, advances a cumulative watermark across requests, and batches redemption.

## Import Paths

| Role | Import |
|------|--------|
| Client | `@x402/svm/batch-settlement/client` |
| Server | `@x402/svm/batch-settlement/server` |
| Facilitator | `@x402/svm/batch-settlement/facilitator` |

## Client Usage

Register `BatchSvmScheme` with an `x402Client`. The SDK opens or tops up the channel on first use, tracks cumulative spend locally, and attaches the correct payload (`voucher` or `authorization`) per mode.

```typescript
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { BatchSvmScheme } from "@x402/svm/batch-settlement/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const signer = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY!),
);

const client = new x402Client();
client.register("solana:*", new ExactSvmScheme(signer)); // fixed-price services
client.register("solana:*", new BatchSvmScheme(signer, {
  depositPolicy: { depositMultiplier: 5 },
  rpcUrl: process.env.SVM_RPC_URL,
}));
```

### Deposit sizing

When a channel needs funding or top-up, the client targets:

1. `extra.minDeposit` when the server announced a valid hint (`>=` per-request `amount`)
2. otherwise `amount × depositMultiplier` (default 5, minimum 3)

`x402Client` spend controls still cap each request's `PaymentRequirements.amount`. The same resolved cap scales the escrow ceiling when a spend cap is set.

### Client-signed channels

No extra client configuration is required. Each paid request carries a cumulative voucher signed by the payer (or a dedicated voucher key equal to `payerAuthorizer`). The per-request charge equals `PaymentRequirements.amount` — there is no metered override on this accept.

### Server-signed channels (trusted operator)

Opt in explicitly. List operators you trust out of band and cap escrow per channel:

```typescript
const batch = new BatchSvmScheme(signer, {
  serverSignedChannelsPolicy: {
    allowedOperators: ["OperatorBase58Pubkey"],
    maxDeposit: "$1", // USD cap for default assets; use `allowedAssets` for other mints
  },
});

client.register("solana:*", batch);
// Optional: prefer a trusted operator's metered accept over a fixed-price accept on the same route
client.registerPolicy(batch.paymentPolicy);
```

If a 402 advertises `extra.voucherSigner: "server"` for an operator not in `allowedOperators`, payment creation fails with `UntrustedOperatorError` and the scheme retries the same resource's `extra.voucherSigner: "client"` accept when offered.

### Cooperative refund

Return unused escrow without waiting for `withdrawDelay` when the server and facilitator cooperate:

```typescript
const settle = await batch.refund("https://api.example.com/protected-route");
// Partial: await batch.refund(url, { amount: "1000000" });
```

### Persistence

Channel allocations default to in-memory. Implement `BatchClientChannelStorage` or keep `channelStorage` durable across restarts so the client does not reopen channels or lose pending state.

## Server Usage

Register `BatchSvmScheme` with an `x402ResourceServer`. The server owns the offchain voucher watermark: verify reserves capacity, the handler runs, settle commits the charge and stores the latest voucher for redemption.

### Receiver authorizer

Every channel is bound at `open` to `extra.receiverAuthorizer` via an onchain Memo. That key signs cooperative `CloseAuthorization` messages for refunds and for sealing channels the payer is closing.

- **Self-managed** (recommended): pass `receiverAuthorizer` in `BatchSvmServerConfig`. Advertised as `extra.receiverAuthorizer`; must match the binding Memo the client includes at open. 
- **Facilitator-delegated**: omit `receiverAuthorizer`. Copy `extra.receiverAuthorizer` from the facilitator's `/supported` advertisement. Cooperative closes authenticate the caller identity at the facilitator instead of a local `CloseAuthorization`.

```typescript
import { BatchSvmScheme, MemoryChannelStore } from "@x402/svm/batch-settlement/server";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const receiverAuthorizer = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY!),
);

new BatchSvmScheme({
  receiverAuthorizer,
  withdrawDelay: 86_400,
  store: new MemoryChannelStore(),
});
```

### Client-signed routes

Omit `operator`. Routes advertise batch-settlement without `extra.voucherSigner` (client mode). Charge is fixed to the route `price` / `amount`.

### Server-signed routes (metered)

Configure an `operator` signer. Once set, batch routes default to server mode and advertise `extra.operator` and `extra.voucherSigner: "server"`. Pin a route back to client mode with `extra.voucherSigner: "client"` so untrusted clients can still pay the ceiling with their own vouchers.

```typescript
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { BatchSvmScheme } from "@x402/svm/batch-settlement/server";

const operator = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_OPERATOR_PRIVATE_KEY!),
);

const server = new x402ResourceServer(facilitatorClient).register(
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  new BatchSvmScheme({
    receiverAuthorizer,
    operator,
    store: new MemoryChannelStore(),
  }),
);

const routes = {
  "GET /api/generate": {
    accepts: [
      {
        scheme: "batch-settlement",
        price: "$0.10", // ceiling per request in server mode
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payTo: "YourSolanaAddress",
      },
      {
        scheme: "batch-settlement",
        price: "$0.10",
        network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
        payTo: "YourSolanaAddress",
        extra: { voucherSigner: "client" },
      },
    ],
    description: "Metered API with a client-signed fallback",
  },
};

// Server-signed only: bill actual usage after the handler runs
app.get("/api/generate", (req, res) => {
  setSettlementOverrides(res, { amount: "50%" }); // or raw atomic units / dollar price
  res.json({ result: "..." });
});
```

### Settlement override formats (server-signed)

The `amount` in `setSettlementOverrides` supports the same formats as upto:

| Format | Example | Description |
|--------|---------|-------------|
| Raw atomic units | `"50000"` | Cumulative increment for this request |
| Percentage | `"50%"` | Fraction of the authorized ceiling |
| Dollar price | `"$0.05"` | Converts to atomic units when the route used `$` pricing |

### Redemption worker

Vouchers are worthless until claimed onchain. Start `BatchChannelManager` outside the request path to claim batches and distribute payouts:

```typescript
const supported = await facilitatorClient.getSupported();
const kind = supported.kinds.find(
  k => k.scheme === "batch-settlement" && k.network === SVM_NETWORK,
);
const requirements = await batchedSvmScheme.enhancePaymentRequirements(
  { scheme: "batch-settlement", network: SVM_NETWORK, amount: "10000", asset: "...", payTo, maxTimeoutSeconds: 300, extra: {} },
  kind!,
  [],
);

const manager = batchedSvmScheme.createChannelManager(facilitatorClient, requirements, {
  rpcUrl: process.env.SVM_RPC_URL,
  onClaim: r => console.log(`Claimed ${r.vouchers} vouchers (tx: ${r.transaction})`),
  onSettle: r => console.log(`Distributed to payTo (tx: ${r.transaction})`),
  onSeal: r => console.log(`Sealed channel ${r.channel} (tx: ${r.transaction})`),
  onError: e => console.error(e),
});
manager.start(60); // seconds between passes
```

Claim promptly: if the facilitator or payer forces a close before your latest voucher is claimed, unclaimed value returns to the payer.

## Facilitator Usage

For custom facilitator implementations:

```typescript
import { toFacilitatorSvmSigner } from "@x402/svm";
import {
  BatchSvmScheme,
  InMemoryBatchChannelStorage,
  InMemoryBatchDelegatedAuthStore,
  InMemoryBatchReceiverAuthorizerStore,
} from "@x402/svm/batch-settlement/facilitator";

const svmSigner = toFacilitatorSvmSigner(
  keypair,
  process.env.SVM_RPC_URL ? { defaultRpcUrl: process.env.SVM_RPC_URL } : undefined,
);

const scheme = new BatchSvmScheme(svmSigner, {
  channelStorage: new InMemoryBatchChannelStorage(),
  receiverAuthorizerStore: new InMemoryBatchReceiverAuthorizerStore(),
  // Optional delegated closes. `receiverAuthorizer` is a Solana address you
  // choose, separate from the fee-payer signers. This facilitator does not
  // sign with it: a channel bound to that address authenticates seal and
  // cooperative refund by caller identity instead of CloseAuthorization.
  // delegatedReceiverAuth: {
  //   receiverAuthorizer,
  //   identityStore: new InMemoryBatchDelegatedAuthStore(),
  //   resolveCallerIdentity: () => callerIdentity,
  // },
});

const rentCleanup = scheme.createRentCleanupManager(network);
rentCleanup.start({
  intervalSecs: 60,
  abandonGraceSecs: 120,
});
```

Configure `receiverAuthorizerStore`, `receiverBindingHistoryReader`, or both. The history reader is used only when set here; it is not taken from the signer. A store-only facilitator binds the receiver authorizer and reads it back before broadcasting an open, and does not broadcast if that write fails. When both are set, a failed store write still broadcasts the open. The binding is checked on cooperative `seal` and `refund` only.

`getExtra()` advertises `feePayer` (channel `rent_payer` and zero-share `payee`) and, when idle cleanup is enabled, `maxIdleSecs`. It advertises `receiverAuthorizer` only when `delegatedReceiverAuth` is set. `withdrawDelay` comes from the server. Production deployments should use durable `pendingSettlementStore`, a shared `channelStorage`, and a shared `identityStore` when running multiple replicas.

## Supported Networks

Works on Solana networks where the payment-channels program is deployed:

| Network | CAIP-2 ID |
|---------|-----------|
| Solana Mainnet Beta | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Solana Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |

Canonical program id: `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`

## How It Works

1. Server advertises `scheme: "batch-settlement"` with per-request `price`, plus `extra.receiverAuthorizer`, `extra.withdrawDelay`, and (in server mode) `extra.operator` / `extra.voucherSigner: "server"`
2. Facilitator advertises `extra.feePayer` and optional `extra.maxIdleSecs`
3. Client signs `open` (or top-up) with the receiver-binding Memo; facilitator broadcasts deposit (escrow settle, before handler)
4. Each request: client mode sends a cumulative voucher; server mode sends a payer authorization and the operator signs the metered cumulative voucher after serving
5. Server verifies offchain, serves, and accumulates the latest voucher locally
6. `BatchChannelManager` submits `claim` (batched `settle`) and `settle` (`distribute`) through the facilitator
7. Cooperative `refund` or payer `request_close` returns unused escrow per the spec; rent cleanup reclaims abandoned channel PDAs

## Examples

- [Express batch-settlement server](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/batch-settlement) (EVM + SVM, dual accepts when an operator is configured)
- [Batch-settlement client](https://github.com/x402-foundation/x402/tree/main/examples/typescript/clients/batch-settlement) (`SVM_SERVER_SIGNED_OPERATORS` for trusted operators)
- [Batch-settlement facilitator](https://github.com/x402-foundation/x402/tree/main/examples/typescript/facilitator/batch-settlement)

## See Also

- [Exact SVM Scheme](../../README.md) — fixed-price SPL transfers
- [Upto SVM Scheme](../upto/README.md) — single-request metered channels
- [Batch-Settlement EVM Scheme](../../../evm/src/batch-settlement/README.md) — EVM counterpart
- [SVM `batch-settlement` Scheme Spec](../../../../../../specs/schemes/batch-settlement/scheme_batch_settlement_svm.md)
- [x402 Docs: Payment Schemes](https://docs.x402.org/getting-started/quickstart-for-sellers#payment-schemes-exact-vs-upto)
