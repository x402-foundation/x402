# Well-Known Discovery Example Server

Express.js server demonstrating the per-origin discovery manifest at
**`/.well-known/x402.json`**, served automatically by the x402 middleware.

The key point: there is **no** `app.get("/.well-known/x402.json", ...)` in `index.ts`.
Using `paymentMiddleware` is enough — the manifest is generated from your route
config (the same path that produces live `402` responses) and served for free.

## Run it (offline, zero setup)

From `examples/typescript`:

```bash
pnpm install
pnpm --filter @x402/well-known-server-example dev
```

If `FACILITATOR_URL` is not set, the example starts a tiny local stub facilitator
(answering only `GET /supported`) so it runs fully offline with no keys.

Then, in another terminal:

```bash
curl -s http://localhost:4022/.well-known/x402.json | jq
```

You should see a manifest like:

```jsonc
{
  "x402Version": 2,
  "items": [
    {
      "resource": "http://localhost:4022/weather/:city",
      "type": "http",
      "x402Version": 2,
      "accepts": [
        { "scheme": "exact", "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
          "amount": "1000", "asset": "<devnet-USDC-mint>",
          "payTo": "Gsbw…", "maxTimeoutSeconds": 300, "extra": { "feePayer": "Gsbw…" } }
      ],
      "lastUpdated": "…",
      "description": "Weather data for a city",
      "serviceName": "Example Weather",
      "tags": ["weather"],
      "extensions": { "bazaar": { "info": { … }, "routeTemplate": "/weather/:city" } }
    }
  ]
}
```

## Options

| Env | Default | Notes |
|-----|---------|-------|
| `PORT` | `4022` | Server port |
| `SVM_ADDRESS` | a placeholder Solana address | The `payTo` recipient (Solana Devnet) |
| `FACILITATOR_URL` | local stub | Set to a real Solana-capable facilitator to use it instead |

To disable the auto-served manifest, pass `false` as the last argument to
`paymentMiddleware(routes, server, undefined, undefined, true, false)`.
