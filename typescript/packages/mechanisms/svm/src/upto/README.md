# Upto SVM Scheme (`@x402/svm/upto`)

The **upto** scheme enables usage-based billing on Solana. The client authorizes a **maximum** payment amount, but the server settles **only what was actually used**. This is ideal for variable-cost endpoints like LLM token generation, compute time, or bandwidth metering.

Uses the [payment-channels](https://github.com/solana-foundation/payment-channels) program. The client escrows the ceiling in an onchain channel; the server later settles the actual amount with a signed cumulative voucher. The facilitator sponsors fees/rent as a zero-share channel payee and can always close abandoned channels to recover rent.

## Import Paths

| Role | Import |
|------|--------|
| Client | `@x402/svm/upto/client` |
| Server | `@x402/svm/upto/server` |
| Facilitator | `@x402/svm/upto/facilitator` |

## Client Usage

Register `UptoSvmScheme` with an `x402Client` to handle payments for services that use the `upto` scheme. From the buyer's perspective, usage is transparent — the SDK signs a max-authorization (`open`) and the server charges only what was consumed.

```typescript
import { x402Client } from "@x402/core/client";
import { ExactSvmScheme } from "@x402/svm/exact/client";
import { UptoSvmScheme } from "@x402/svm/upto/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const signer = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_PRIVATE_KEY!),
);

const client = new x402Client();
client.register("solana:*", new ExactSvmScheme(signer)); // fixed-price services
client.register("solana:*", new UptoSvmScheme(signer));  // usage-based services
```

### Key Difference from Exact

The upto client requires `paymentRequirements.extra.feePayer` and `extra.receiverAuthorizer` (provided via facilitator `getExtra()` and server enhancement). The client signs only the channel `open`; the facilitator co-signs as fee/rent payer and later submits settlement carrying a `receiverAuthorizer` voucher (server-signed, or facilitator-signed when delegated).

## Server Usage

Register `UptoSvmScheme` with an `x402ResourceServer` and use `setSettlementOverrides` in your handler to specify the actual charge.

### Receiver Authorizer

The `receiverAuthorizer` signs settlement vouchers and is committed as the channel `authorized_signer` at deposit:

- **Self-managed** (recommended): pass a `receiverAuthorizerSigner` (a hot Ed25519 key; it does not need SOL or tokens). Channels survive facilitator changes — any facilitator can relay your signed vouchers.
- **Facilitator-delegated**: omit `receiverAuthorizerSigner`. The scheme picks up `extra.receiverAuthorizer` advertised by the facilitator's `/supported`. The server needs no voucher-signing key; the facilitator signs after authenticating that the claim settle comes from the same service that opened the channel. Delegation requires an out-of-band agreement with the facilitator plus authenticated server→facilitator settle calls — it is not part of the client payment flow.

Self-managed:

```typescript
import { UptoSvmScheme } from "@x402/svm/upto/server";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { base58 } from "@scure/base";

const receiverAuthorizerSigner = await createKeyPairSignerFromBytes(
  base58.decode(process.env.SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY!),
);

new UptoSvmScheme({
  receiverAuthorizerSigner,
  rpcUrl: process.env.SVM_RPC_URL, // optional: embeds recentBlockhash/recentSlot in 402
});
```

Facilitator-delegated (omit `receiverAuthorizerSigner` only; `rpcUrl` unchanged):

```typescript
new UptoSvmScheme({
  rpcUrl: process.env.SVM_RPC_URL, // optional: same as self-managed
});
```

Full server wiring:

```typescript
import { paymentMiddleware, setSettlementOverrides, x402ResourceServer } from "@x402/express";
import { UptoSvmScheme } from "@x402/svm/upto/server";

const server = new x402ResourceServer(facilitatorClient).register(
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  new UptoSvmScheme({
    receiverAuthorizerSigner, // omit for facilitator-delegated mode
    rpcUrl: process.env.SVM_RPC_URL,
  }),
);
const routes = {
  "GET /api/generate": {
    accepts: {
      scheme: "upto",
      price: "$0.10",           // client authorizes up to 10 cents
      network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      payTo: "YourSolanaAddress",
    },
    description: "AI text generation — billed by token usage",
  },
};

// In your handler, settle the actual usage:
app.get("/api/generate", (req, res) => {
  const actualUsage = computeActualCost(); // your billing logic
  setSettlementOverrides(res, { amount: String(actualUsage) });
  res.json({ result: "..." });
});
```

### Settlement Override Formats

The `amount` in `setSettlementOverrides` supports three formats:

| Format | Example | Description |
|--------|---------|-------------|
| Raw atomic units | `"50000"` | Settles exactly 50,000 atomic units |
| Percentage | `"50%"` | Settles 50% of the authorized maximum |
| Dollar price | `"$0.05"` | Converts to atomic units (when route used `$` pricing) |

Setting `amount` to `"0"` settles a zero-charge close — the deposit is refunded to the client (no payment to `payTo`).

## Facilitator Usage

For custom facilitator implementations:

```typescript
import { toFacilitatorSvmSigner } from "@x402/svm";
import { UptoSvmScheme } from "@x402/svm/upto/facilitator";

// Pass the RPC URL to the signer, not to UptoSvmScheme
const svmSigner = toFacilitatorSvmSigner(
  keypair,
  process.env.SVM_RPC_URL ? { defaultRpcUrl: process.env.SVM_RPC_URL } : undefined,
);
const scheme = new UptoSvmScheme(svmSigner, {
  maxChannelLifetimeSecs: 3600,
  // Optional: advertise a receiverAuthorizer so servers can delegate.
  // Requires resolveCallerIdentity — construction throws without it.
  authorizerSigner,
  resolveCallerIdentity: ctx => currentRequestAuth(ctx).subject,
  // Optional: shared store for multi-replica facilitators. Default is in-memory.
});

// Optional: reclaim PDA rent from sealed/distributed channels
const rentCleanup = scheme.createRentCleanupManager(network);
rentCleanup.start({ intervalSecs: 60, discoveryIntervalSecs: 86_400 });
```

Cleanup works from the scheme's channel storage. `discoveryIntervalSecs`
additionally arms `discover()`, the spec §6 recovery sweep that finds
Distributed channels this facilitator paid rent for that storage lost track of
and adds them for a later cleanup pass to reclaim. A sweep is a
`getProgramAccounts` scan per managed signer, so run it rarely — daily, not on
the cleanup interval. Omit it to leave discovery off.

`stop()` returns a promise: it cancels the loops and waits for the in-flight
pass, so await it during shutdown rather than exiting underneath a broadcast
settle.

The upto facilitator's `getExtra()` returns a `feePayer` address and, when `authorizerSigner` is set, a `receiverAuthorizer`. `feePayer` is set as channel `payee` (zero distribution share) and `rent_payer`: it co-signs `open`, sponsors fees/rent, and signs `settle_and_seal`.

A facilitator that advertises a `receiverAuthorizer` (so servers can delegate to it) must authenticate that each claim settle originates from the service whose deposit settle opened the channel (e.g. SIWX, JWT, or an API credential correlated across the two settles). The scheme records that identity at deposit and requires an exact match at claim. If the facilitator has no such authentication mechanism, omit `authorizerSigner` so no `receiverAuthorizer` is advertised; servers then supply their own voucher signatures.

The default identity store is in-memory. A multi-replica facilitator must inject a shared `delegatedAuthStore`; a lost binding fails closed and the server cannot settle (the client still has `request_close`).

## Supported Networks

Works on Solana networks where the payment-channels program is deployed:

| Network | CAIP-2 ID |
|---------|-----------|
| Solana Mainnet Beta | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` |
| Solana Devnet | `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` |

Canonical program id: `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX`

## How It Works

1. Server advertises `scheme: "upto"` with a max `price`, plus `extra.receiverAuthorizer` / `extra.withdrawDelay`
2. Facilitator advertises `extra.feePayer`
3. Client signs a payment-channel `open` that escrows the max amount
4. Facilitator deposits by broadcasting `open` (escrow settle, before handler)
5. Server performs work, calculates actual cost, and attaches `type` plus a voucher when it owns the key
6. Facilitator claims with `settle_and_seal` + `distribute` for the actual amount (≤ max)
7. If actual amount is `0`, the channel closes with a full refund to the client

## Examples

- [Express upto server](https://github.com/x402-foundation/x402/tree/main/examples/typescript/servers/upto)
- [Upto facilitator](https://github.com/x402-foundation/x402/tree/main/examples/typescript/facilitator/upto)

## See Also

- [Exact SVM Scheme](../../README.md) — fixed-price SPL transfers
- [Upto EVM Scheme](../../../evm/src/upto/README.md) — EVM counterpart (Permit2)
- [SVM `upto` Scheme Spec](../../../../../../specs/schemes/upto/scheme_upto_svm.md)
- [x402 Docs: Payment Schemes](https://docs.x402.org/getting-started/quickstart-for-sellers#payment-schemes-exact-vs-upto)
