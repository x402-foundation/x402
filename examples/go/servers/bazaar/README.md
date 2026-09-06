# Bazaar Discovery Example Server (Go)

Gin server demonstrating how to make a paid API **discoverable** using the Bazaar extension with dynamic route parameters.

The key addition over a basic x402 server is `DeclareDiscoveryExtension` -- it describes your endpoint's inputs, outputs, and path parameters so that facilitators (and agents) can automatically catalog and invoke your API.

## What This Example Shows

**Dynamic route parameters** -- the route `GET /weather/:city` uses a `:city` slug. The x402 middleware automatically:

1. Matches `/weather/san-francisco`, `/weather/tokyo`, etc. against the route pattern
2. Extracts `{ city: "san-francisco" }` as `pathParams` in the discovery extension
3. Produces `routeTemplate: "/weather/:city"` so all concrete URLs consolidate into **one** catalog entry

```go
weatherExtension, _ := bazaar.DeclareDiscoveryExtension(
    bazaar.MethodGET, nil, nil, "",
    &types.OutputConfig{
        Example: map[string]interface{}{"city": "san-francisco", "weather": "foggy", "temperature": 60},
    },
    bazaar.DeclareDiscoveryExtensionOpts{
        PathParamsSchema: types.JSONSchema{
            "properties": map[string]interface{}{
                "city": map[string]interface{}{"type": "string", "description": "City name slug"},
            },
            "required": []string{"city"},
        },
    },
)

routes := x402http.RoutesConfig{
    "GET /weather/:city": {
        Accepts:     x402http.PaymentOptions{{Scheme: "exact", Price: "$0.001", ...}},
        Description: "Weather data for a city",
        Extensions:  map[string]interface{}{bazaar.BAZAAR.Key(): weatherExtension},
    },
}
```

Note that the x402 route key uses `:city` which aligns with both Express convention and Gin's `c.Param("city")` extraction.

## Prerequisites

- Go 1.24 or higher
- Valid EVM address for receiving payments
- Valid SVM address for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

and fill required environment variables:

- `FACILITATOR_URL` - Facilitator endpoint URL
- `EVM_PAYEE_ADDRESS` - Ethereum address to receive payments
- `SVM_PAYEE_ADDRESS` - Solana address to receive payments

2. Install dependencies:
```bash
go mod download
```

3. Run the server:
```bash
go run main.go
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
| `GET /weather/:city` | Yes | $0.001 USDC |
| `GET /weather/:country/:city` | Yes | $0.001 USDC |

## Multiple Path Parameters

Routes can have multiple `:param` segments. Param names are matched by **position in the URL**, not by the order they appear in `PathParamsSchema`:

```
GET /weather/:country/:city
                 ^         ^
                 |         └── second URL segment -> "city"
                 └──────────── first URL segment  -> "country"
```

A request to `/weather/us/san-francisco` produces `pathParams: { country: "us", city: "san-francisco" }`. The property order in `PathParamsSchema` does not affect matching -- only the segment position in the URL matters.

## `DeclareDiscoveryExtension` API

```go
func DeclareDiscoveryExtension(
    method interface{},           // bazaar.MethodGET, bazaar.MethodPOST, etc.
    input interface{},            // Example input data (query params or body)
    inputSchema types.JSONSchema, // JSON Schema for input
    bodyType types.BodyType,      // For POST/PUT/PATCH: "json", "form-data", "text"
    output *types.OutputConfig,   // Example response
    opts ...DeclareDiscoveryExtensionOpts, // PathParamsSchema
) (types.DiscoveryExtension, error)
```

The optional `DeclareDiscoveryExtensionOpts` struct provides `PathParamsSchema` for describing URL path parameters.
