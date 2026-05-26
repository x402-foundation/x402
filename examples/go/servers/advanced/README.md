# x402-gin Advanced Examples

Gin server demonstrating advanced x402 patterns including dynamic pricing, payment routing, lifecycle hooks and API discoverability.

## Prerequisites

- Go 1.21 or higher
- Valid EVM address for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Copy `.env-example` to `.env`:

```bash
cp .env-example .env
```

and fill required environment variables:

- `FACILITATOR_URL` - Facilitator endpoint URL
- `EVM_PAYEE_ADDRESS` - Ethereum address to receive payments

2. Install dependencies:

```bash
go mod download
```

3. Run an example (each example is standalone):

```bash
go run hooks.go
```

## Available Examples

Each example demonstrates a specific advanced pattern:

| Example | Command | Description |
| --- | --- | --- |
| `all-networks` | `go run all_networks.go` | All supported networks with optional chain configuration |
| `bazaar` | `go run bazaar.go` | API discoverability via Bazaar |
| `hooks` | `go run hooks.go` | Payment lifecycle hooks |
| `dynamic-price` | `go run dynamic-price.go` | Context-based pricing |
| `dynamic-pay-to` | `go run dynamic-pay-to.go` | Route payments to different recipients |
| `custom-money-definition` | `go run custom-money-definition.go` | Accept alternative tokens |

## Testing the Server

You can test the server using one of the example clients:

### Using the Go Client

```bash
cd ../../clients/custom
# Ensure .env is setup
go run main.go
```

## Example: Bazaar Discovery

Adding the discovery extension to make your API discoverable:

```go
discoveryExtension, err := bazaar.DeclareDiscoveryExtension(
    bazaar.MethodGET,
    map[string]interface{}{"city": "San Francisco"},
    types.JSONSchema{
        "properties": map[string]interface{}{
            "city": map[string]interface{}{
                "type":        "string",
                "description": "City name to get weather for",
            },
        },
        "required": []string{"city"},
    },
    "",
    &types.OutputConfig{
        Example: map[string]interface{}{
            "city": "San Francisco", "weather": "foggy", "temperature": 60,
        },
    },
)

routes := x402http.RoutesConfig{
    "GET /weather": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                PayTo:   evmPayeeAddress,
                Price:   "$0.001",
                Network: evmNetwork,
            },
        },
        Description: "Weather data",
        MimeType:    "application/json",
        Extensions: map[string]interface{}{
            types.BAZAAR: discoveryExtension,
        },
    },
}
```

**Use case:** Clients and AI agents can easily discover your service

## Example: Dynamic Pricing

Calculate prices at runtime based on request context:

```go
dynamicPrice := func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (x402.Price, error) {
    tier := "standard" // Extract from request context
    if tier == "premium" {
        return "$0.005", nil // Premium tier: 0.5 cents
    }
    return "$0.001", nil // Standard tier: 0.1 cents
}

routes := x402http.RoutesConfig{
    "GET /weather": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                PayTo:   evmPayeeAddress,
                Price:   x402http.DynamicPriceFunc(dynamicPrice),
                Network: evmNetwork,
            },
        },
    },
}
```

**Use case:** Implementing tiered pricing, user-based pricing, content-based pricing or any scenario where the price varies based on the request.

## Example: Dynamic PayTo

Route payments to different recipients based on request context:

```go
addressLookup := map[string]string{
    "US": "0x...",
    "UK": "0x...",
}

dynamicPayTo := func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (string, error) {
    country := "US" // Extract from request context
    address, ok := addressLookup[country]
    if !ok {
        address = defaultAddress
    }
    return address, nil
}

routes := x402http.RoutesConfig{
    "GET /weather": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                PayTo:   x402http.DynamicPayToFunc(dynamicPayTo),
                Price:   "$0.001",
                Network: evmNetwork,
            },
        },
    },
}
```

**Use case:** Marketplace applications where payments should go to different sellers, content creators, or service providers based on the resource being accessed.

## Example: Lifecycle Hooks

Run custom logic before/after verification and settlement:

```go
// Create facilitator client
facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
    URL: facilitatorURL,
})

// Create x402 resource server with hooks
server := x402.Newx402ResourceServer(
    x402.WithFacilitatorClient(facilitatorClient),
).
    Register(evmNetwork, evm.NewExactEvmScheme()).
    OnBeforeVerify(func(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
        fmt.Println("Before verify hook", ctx)
        // Abort verification by returning &x402.BeforeHookResult{Abort: true, Reason: "..."}
        return nil, nil
    }).
    OnAfterSettle(func(ctx x402.SettleResultContext) error {
        // Log payment to database
        db.RecordTransaction(ctx.Result.Transaction, ctx.Result.Payer)
        return nil
    }).
    OnSettleFailure(func(ctx x402.SettleFailureContext) (*x402.SettleFailureHookResult, error) {
        // Return a result with Recovered=true to recover from the failure
        // return &x402.SettleFailureHookResult{Recovered: true, Result: &x402.SettleResponse{...}}
        return nil, nil
    })

// Use PaymentMiddleware with the pre-configured server
r := gin.Default()
r.Use(ginmw.PaymentMiddleware(routes, server))
```

Available hooks:

- `OnBeforeVerify` — Run before verification (can abort)
- `OnAfterVerify` — Run after successful verification
- `OnVerifyFailure` — Run when verification fails (can recover)
- `OnBeforeSettle` — Run before settlement (can abort)
- `OnAfterSettle` — Run after successful settlement
- `OnSettleFailure` — Run when settlement fails (can recover)

**Use case:**

- Log payment events to a database or monitoring system
- Perform custom validation before processing payments
- Implement retry or recovery logic for failed payments
- Trigger side effects (notifications, database updates) after successful payments

## Example: Custom Tokens

Accept payments in custom tokens. Register a money parser on the scheme to support alternative tokens for specific networks.

```go
evmScheme := evm.NewExactEvmScheme().RegisterMoneyParser(
    func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
        // Use Wrapped XDAI on Gnosis Chain
        if string(network) == "eip155:100" {
            return &x402.AssetAmount{
                Amount: fmt.Sprintf("%.0f", amount*1e18),
                Asset:  "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d",
                Extra:  map[string]interface{}{"token": "Wrapped XDAI"},
            }, nil
        }
        return nil, nil // Fall through to default parser
    },
)

r.Use(ginmw.X402Payment(ginmw.Config{
    Routes:      routes,
    Facilitator: facilitatorClient,
    Schemes: []ginmw.SchemeConfig{
        {Network: evmNetwork, Server: evmScheme},
    },
}))
```

**Use case:** When you want to accept payments in tokens other than USDC, or use different tokens based on conditions (e.g., DAI for large amounts, custom tokens for specific networks).

## Response Format

### Payment Required (402)

```
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
PAYMENT-REQUIRED: <base64-encoded JSON>

{}
```

The `PAYMENT-REQUIRED` header contains base64-encoded JSON with the payment requirements. Note: `amount` is in atomic units (e.g., 1000 = 0.001 USDC, since USDC has 6 decimals).

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4021/weather",
    "description": "Weather data",
    "mimeType": "application/json"
  },
  "accepts": [
    {
      "scheme": "exact",
      "network": "eip155:84532",
      "amount": "1000",
      "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      "payTo": "0x...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "name": "USDC",
        "version": "2",
        "resourceUrl": "http://localhost:4021/weather"
      }
    }
  ]
}
```

### Successful Response

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
PAYMENT-RESPONSE: <base64-encoded JSON>

{"report":{"weather":"sunny","temperature":70}}
```

The `PAYMENT-RESPONSE` header contains base64-encoded JSON with the settlement details:

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:84532",
  "payer": "0x...",
  "requirements": {
    "scheme": "exact",
    "network": "eip155:84532",
    "amount": "1000",
    "asset": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "payTo": "0x...",
    "maxTimeoutSeconds": 300,
    "extra": {
      "name": "USDC",
      "version": "2",
      "resourceUrl": "http://localhost:4021/weather"
    }
  }
}
```
