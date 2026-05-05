# Next.js batch-settlement (Redis storage)

Next.js demo that exposes **`GET /api/weather`** behind `withX402` with the **batch-settlement** scheme. Channel state uses **`RedisChannelStorage`** (`@x402/evm/batch-settlement/server`), backed by the **`redis`** npm client via `lib/redisChannelClient.ts`.

Parallels:

- Response shape / `withX402` usage: `examples/typescript/fullstack/next/app/api/weather/route.ts`
- Batch-settlement Express example wiring: `examples/typescript/servers/batch-settlement/index.ts`
- Batch-settlement client: `examples/typescript/clients/batch-settlement`

## Prerequisites

- Node.js 20+, pnpm 10
- Redis reachable from the app (`REDIS_URL`)
- A facilitator URL and receiver address (same variables as other examples)

## Setup

From `examples/typescript`:

```bash
pnpm install && pnpm build
cd fullstack/next-batch-settlement-redis
```

Copy `.env-local` to `.env` (or create `.env`) and set:

| Variable | Required | Description |
|----------|----------|-------------|
| `FACILITATOR_URL` | yes | Facilitator HTTP endpoint |
| `EVM_ADDRESS` | yes | Receiver `0x…` address |
| `REDIS_URL` | yes | e.g. `redis://127.0.0.1:6379` |
| `EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY` | no | Local receiver-authorizer signer (omit to use facilitator) |
| `DEFERRED_WITHDRAW_DELAY_SECONDS` | no | Defaults to `108000` (30 hours) |
| `CRON_SECRET` | no | Bearer token required by cron routes when set |

```bash
pnpm dev
```

Paid endpoint: **`GET /api/weather`**.

## Cron Jobs

Run cron jobs locally before deploying:

```bash
pnpm cron:claim
pnpm cron:settle
pnpm cron:claim-and-settle
```

`cron:claim` claims up to 100 vouchers per facilitator transaction. `cron:settle` settles already-claimed funds. `cron:claim-and-settle` does both in one operation and skips settlement when there are no claim transactions.

The shared cron helpers accept the same `selectClaimChannels` option as the background `ChannelManager` runner, so custom jobs can claim a subset without duplicating claim batching or signing logic:

```typescript
await runClaimAndSettleCron({
  maxClaimsPerBatch: 100,
  selectClaimChannels: channels =>
    channels.filter(channel => channel.withdrawRequestedAt > 0),
});
```

Vercel deployment uses `vercel.json` to call **`GET /api/cron/claim-and-settle`** once per day at `02:00 UTC`, which is compatible with Vercel Hobby cron limits. Set `CRON_SECRET` in Vercel to require `Authorization: Bearer <secret>` for manual calls.

With a daily cron, `DEFERRED_WITHDRAW_DELAY_SECONDS` must exceed the daily cadence plus Vercel's hourly scheduling precision and operational safety margin. The default 30-hour delay is intended for this deployment shape. More frequent claim, settle, or refund policies require Vercel Pro cron frequency or an external scheduler.

## Files

- `lib/server.ts` — facilitator client, `BatchSettlementEvmScheme` + `RedisChannelStorage`
- `lib/cron.ts` — shared claim, settle, and claim-and-settle cron implementations
- `lib/cronAuth.ts` — optional bearer-token check for cron routes
- `lib/redisChannelClient.ts` — lazy `redis` adapter implementing `RedisChannelStorageClient`
- `app/api/weather/route.ts` — `withX402` + batch-settlement (weather JSON, discovery extension)
- `app/api/cron/*/route.ts` — claim, settle, and claim-and-settle cron routes
- `scripts/cron.ts` — local cron runner
