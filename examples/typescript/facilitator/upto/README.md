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

1. Registers `UptoSvmScheme` with shared `InMemoryUptoChannelStorage`.
2. Creates a rent cleanup manager via `scheme.createRentCleanupManager(network)`.
3. Starts an interval loop (`RENT_CLEANUP_INTERVAL_SECS`, default 300s).

Tune policy with:

| Env var                           | Default | Purpose                                                 |
| --------------------------------- | ------- | ------------------------------------------------------- |
| `RENT_CLEANUP_INTERVAL_SECS`      | `300`   | Seconds between cleanup ticks                           |
| `RENT_CLEANUP_ABANDON_GRACE_SECS` | `120`   | Grace after voucher expiry before abandon-close         |
| `MAX_CHANNEL_LIFETIME_SECS`       | `3600`  | Max `maxTimeoutSeconds` / `expiresAt` at verify/deposit |

For production, replace `InMemoryUptoChannelStorage` with a durable store so cleanup survives restarts and works across facilitator replicas.

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
