# Bazaar Discovery Example Server (Python)

FastAPI server demonstrating how to make a paid API **discoverable** using the Bazaar extension with dynamic route parameters.

The key addition over a basic x402 server is `declare_discovery_extension` -- it describes your endpoint's inputs, outputs, and path parameters so that facilitators (and agents) can automatically catalog and invoke your API.

## What This Example Shows

**Dynamic route parameters** -- the route `GET /weather/:city` uses a `:city` slug. The x402 middleware automatically:

1. Matches `/weather/san-francisco`, `/weather/tokyo`, etc. against the route pattern
2. Extracts `{ city: "san-francisco" }` as `pathParams` in the discovery extension
3. Produces `routeTemplate: "/weather/:city"` so all concrete URLs consolidate into **one** catalog entry

```python
from x402.extensions.bazaar import declare_discovery_extension, OutputConfig

routes = {
    "GET /weather/:city": RouteConfig(
        accepts=[
            PaymentOption(scheme="exact", price="$0.01", network=EVM_NETWORK, pay_to=EVM_ADDRESS),
        ],
        description="Weather data for a city",
        extensions=declare_discovery_extension(
            path_params_schema={
                "properties": {"city": {"type": "string", "description": "City name slug"}},
                "required": ["city"],
            },
            output=OutputConfig(
                example={"city": "san-francisco", "weather": "foggy", "temperature": 60}
            ),
        ),
    ),
}

@app.get("/weather/{city}")
async def get_weather(city: str) -> dict:
    ...
```

Note that the x402 route key uses `:city` (Express convention) while the FastAPI handler uses `{city}` (FastAPI convention). The x402 middleware handles the `:city` matching; FastAPI handles the `{city}` extraction for your handler.

## Prerequisites

- Python 3.10+
- uv (install via [docs.astral.sh/uv](https://docs.astral.sh/uv/getting-started/installation/))
- Valid EVM address for receiving payments (Base Sepolia)
- Valid SVM address for receiving payments (Solana Devnet)
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-local` to `.env`:

```bash
cp .env-local .env
```

2. Fill required environment variables:

- `EVM_ADDRESS` - Ethereum address to receive payments (Base Sepolia)
- `SVM_ADDRESS` - Solana address to receive payments (Solana Devnet)
- `FACILITATOR_URL` - Facilitator endpoint URL (optional, defaults to production)

3. Install dependencies:

```bash
uv sync
```

4. Run the server:

```bash
uv run python main.py
```

Server runs at http://localhost:4021

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
      }
    }
  },
  "accepts": [{ "..." : "..." }]
}
```

The facilitator uses `routeTemplate` as the canonical catalog key, so requests to `/weather/san-francisco`, `/weather/tokyo`, and `/weather/new-york` all map to a single discoverable endpoint: `/weather/:city`.

## Example Endpoints

| Endpoint | Payment | Price |
|----------|---------|-------|
| `GET /health` | No | - |
| `GET /weather/:city` | Yes | $0.01 USDC |
| `GET /weather/:country/:city` | Yes | $0.01 USDC |

## Multiple Path Parameters

Routes can have multiple `:param` segments. Param names are matched by **position in the URL**, not by the order they appear in `path_params_schema`:

```
GET /weather/:country/:city
                 ^         ^
                 |         └── second URL segment -> "city"
                 └──────────── first URL segment  -> "country"
```

A request to `/weather/us/san-francisco` produces `pathParams: { country: "us", city: "san-francisco" }`. The property order in `path_params_schema` does not affect matching -- only the segment position in the URL matters.

## `declare_discovery_extension` API

| Parameter | Purpose |
|-----------|---------|
| `input` | Example query parameter values (for GET/HEAD/DELETE) |
| `input_schema` | JSON Schema for query parameters |
| `path_params_schema` | JSON Schema for URL path parameters (`:param` segments) |
| `output` | `OutputConfig(example=...)` -- example response body |
| `body_type` | For POST/PUT/PATCH: `"json"`, `"form-data"`, or `"text"` |
