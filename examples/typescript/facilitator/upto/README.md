# Upto Facilitator Example

Express.js facilitator for the **`upto`** scheme on Base Sepolia and/or Solana Devnet. Authorizes a payment ceiling at verify time and settles only the metered amount.

For SVM, this example wires [`UptoSvmRentCleanupManager`](../../../../typescript/packages/mechanisms/svm/src/upto/facilitator/rentCleanupManager.ts) to the scheme's shared channel storage. The manager runs on an interval to abandon-close stale Open channels, distribute Sealed ones, and batch-reclaim rent from Distributed PDAs.

Pair with [`servers/upto/`](../../servers/upto/) for a full usage-based billing flow.

## Prerequisites

- Node.js v20+, pnpm v10
- At least one facilitator key:
  - **EVM**: Base Sepolia ETH for gas (`EVM_PRIVATE_KEY`)
  - **SVM**: Solana Devnet SOL for channel opens and cleanup txs (`SVM_PRIVATE_KEY`)

**Security:** Facilitator keys sign on-chain settlement. Keep them separate from seller `payTo` wallets and fund only for gas.

## Setup

```bash
cp .env-local .env
# fill EVM_PRIVATE_KEY and/or SVM_PRIVATE_KEY

cd ../../
pnpm install && pnpm build
cd facilitator/upto

pnpm dev
```

Default listen address: `http://localhost:4022` (`PORT` to override).

## SVM rent cleanup

When `SVM_PRIVATE_KEY` is set, the example:

1. Registers `UptoSvmScheme` with shared `InMemoryPaymentChannelStorage`.
2. Creates a rent cleanup manager via `scheme.createRentCleanupManager(network)`.
3. Starts an interval loop (`RENT_CLEANUP_INTERVAL_SECS`, default 300s).

Tune policy with:

| Env var                           | Default | Purpose                                                 |
| --------------------------------- | ------- | ------------------------------------------------------- |
| `RENT_CLEANUP_INTERVAL_SECS`      | `300`   | Seconds between cleanup ticks                           |
| `RENT_CLEANUP_ABANDON_GRACE_SECS` | `120`   | Grace after voucher expiry before abandon-close         |
| `MAX_CHANNEL_LIFETIME_SECS`       | `3600`  | Max `maxTimeoutSeconds` / `expiresAt` at verify/deposit |

For production, replace `InMemoryPaymentChannelStorage` with a durable store so cleanup survives restarts and works across facilitator replicas.

## SVM receiver authorizer (optional delegation)

By default this example registers `UptoSvmScheme` with a **fee payer only** — no `authorizerSigner`, so `/supported` advertises `extra.feePayer` but not `extra.receiverAuthorizer`. [`servers/upto/`](../../servers/upto/) without a local `SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` delegates to whatever `receiverAuthorizer` the facilitator advertises and fails fast at startup if none is offered.

Advertise delegation only when you can **authenticate resource-server settle requests out of band** (SIWX, JWT, mTLS, API credentials correlated across deposit and claim, and so on). You must pass an `authorizerSigner` and implement `resolveCallerIdentity` so each delegated deposit/claim settle resolves to a stable caller identity; the scheme records that identity at deposit and rejects claim settles that do not match. **Do not advertise `receiverAuthorizer` without that authentication.** This example does not configure delegation — wire it in your own facilitator as sketched below.

| Signer                        | Role                                                                 | Onchain effect                                                      |
| ----------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `SVM_PRIVATE_KEY`             | **Fee payer** — co-signs channel `open`, submits claim/cleanup txs   | Pays SOL for opens, settlement, and rent cleanup                    |
| `authorizerSigner` (optional) | **Receiver authorizer** — signs claim vouchers when servers delegate | Committed as the channel `authorized_signer` for delegating servers |

When `authorizerSigner` is set, `GET /supported` includes both `feePayer` and `receiverAuthorizer`:

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "upto",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "extra": {
        "feePayer": "...",
        "receiverAuthorizer": "..."
      }
    }
  ]
}
```

Wire it in your facilitator:

```typescript
import { AsyncLocalStorage } from "node:async_hooks";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { UptoSvmScheme } from "@x402/svm/upto/facilitator";

const authorizerSigner =
  await createKeyPairSignerFromBytes(/* dedicated Ed25519 key */);

// Carry authenticated server identity into resolveCallerIdentity (JWT/SIWX/mTLS/etc.).
const callerIdentity = new AsyncLocalStorage<string | undefined>();

const scheme = new UptoSvmScheme(svmSigner, {
  channelStorage,
  maxChannelLifetimeSecs,
  authorizerSigner,
  resolveCallerIdentity: () => callerIdentity.getStore(),
});

// Authenticate the resource server, then run verify/settle with that identity available
// to resolveCallerIdentity (deposit and claim must see the same value).
app.post("/settle", async (req, res) => {
  const identity = authenticateResourceServer(req); // out-of-band auth — your implementation
  const response = await callerIdentity.run(identity, () =>
    facilitator.settle(paymentPayload, paymentRequirements),
  );
  res.json(response);
});
```

Delegated caller identity is stored on the same `channelStorage` row as the channel (default in-memory). Use a durable, shared `channelStorage` when more than one facilitator replica can settle the same channel.

## API Endpoints

Standard x402 facilitator surface: `POST /verify`, `POST /settle`, `GET /supported`.

Supported schemes are **`upto` only** (no `exact`).

## Full stack

```bash
# Terminal 1 — facilitator (this example)
cd facilitator/upto && pnpm dev

# Terminal 2 — resource server
cd servers/upto && FACILITATOR_URL=http://localhost:4022 pnpm dev

# Terminal 3 — any client with upto schemes registered (e.g. clients/fetch)
cd clients/fetch && RESOURCE_SERVER_URL=http://localhost:4021 ENDPOINT_PATH=/api/generate pnpm start
```
