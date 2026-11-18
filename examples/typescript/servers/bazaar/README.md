# Bazaar Discovery Example Server

Express.js server demonstrating how to make a paid API **discoverable** using the Bazaar extension with dynamic route parameters.

The key addition over a basic x402 server is `declareDiscoveryExtension` — it describes your endpoint's inputs, outputs, and path parameters so that facilitators (and agents) can automatically catalog and invoke your API.

## What This Example Shows

**Dynamic route parameters** — the route `GET /weather/:city` uses a `:city` slug. The x402 middleware automatically:

1. Matches `/weather/san-francisco`, `/weather/tokyo`, etc. against the route pattern
2. Extracts `{ city: "san-francisco" }` as `pathParams` in the discovery extension
3. Produces `routeTemplate: "/weather/:city"` so all concrete URLs consolidate into **one** catalog entry

```typescript
import { declareDiscoveryExtension } from "@x402/extensions/bazaar";

app.use(
  paymentMiddleware(
    {
      "GET /weather/:city": {
        accepts: { scheme: "exact", price: "$0.001", network: "eip155:84532", payTo: evmAddress },
        description: "Weather data for a city",
        mimeType: "application/json",
        extensions: {
          ...declareDiscoveryExtension({
            pathParamsSchema: {
              properties: { city: { type: "string", description: "City name slug" } },
              required: ["city"],
            },
            output: {
              example: { city: "san-francisco", weather: "foggy", temperature: 60 },
            },
          }),
        },
      },
    },
    resourceServer,
  ),
);

app.get("/weather/:city", (req, res) => {
  const city = req.params.city;
  // ... return weather for city
});
```

## Prerequisites

- Node.js v20+ (install via [nvm](https://github.com/nvm-sh/nvm))
- pnpm v10 (install via [pnpm.io/installation](https://pnpm.io/installation))
- Valid EVM and SVM addresses for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

and fill required environment variables:

- `FACILITATOR_URL` - Facilitator endpoint URL
- `EVM_ADDRESS` - Ethereum address to receive payments
- `SVM_ADDRESS` - Solana address to receive payments

2. Install and build all packages from the typescript examples root:
```bash
cd ../../
pnpm install && pnpm build
cd servers/bazaar
```

3. Run the server
```bash
pnpm dev
```

## How Discovery Works

When a client hits `GET /weather/san-francisco` without a payment, the 402 response includes the enriched bazaar extension:

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": { "url": "http://localhost:4021/weather/san-francisco" },
  "extensions": {
    "bazaar": {
      "routeTemplate": "/weather/:city",
      "info": {
        "input": {
          "type": "http",
          "method": "GET",
          "pathParams": { "city": "san-francisco" }
        },
        "output": {
          "type": "json",
          "example": { "city": "san-francisco", "weather": "foggy", "temperature": 60 }
        }
      },
      "schema": { "..." : "..." }
    }
  },
  "accepts": [{ "..." : "..." }]
}
```

The facilitator uses `routeTemplate` as the canonical catalog key, so requests to `/weather/san-francisco`, `/weather/tokyo`, and `/weather/new-york` all map to a single discoverable endpoint: `/weather/:city`.

## Multiple Path Parameters

Routes can have multiple `:param` segments. Param names are matched by **position in the URL**, not by the order they appear in `pathParamsSchema`:

```
GET /weather/:country/:city
                 ^         ^
                 |         └── second URL segment -> "city"
                 └──────────── first URL segment  -> "country"
```

A request to `/weather/us/san-francisco` produces `pathParams: { country: "us", city: "san-francisco" }`. The property order in `pathParamsSchema` does not affect matching -- only the segment position in the URL matters.

## `declareDiscoveryExtension` API

The function accepts a config object describing your endpoint:

| Field | Purpose |
|-------|---------|
| `input` | Example query parameter values (for GET/HEAD/DELETE) |
| `inputSchema` | JSON Schema for query parameters |
| `pathParamsSchema` | JSON Schema for URL path parameters (`:param` segments) |
| `output.example` | Example response body (helps agents understand what they'll get) |
| `output.schema` | JSON Schema for the response body |
| `bodyType` | For POST/PUT/PATCH: `"json"`, `"form-data"`, or `"text"` |
