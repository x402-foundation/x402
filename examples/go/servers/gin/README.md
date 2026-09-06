# x402-gin Example Server

Gin server demonstrating how to protect API endpoints with a paywall using the 
`x402/go/http/gin` middleware.

## Prerequisites

- Go 1.24 or higher
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
- `SVM_PAYEE_ADDRESS` - Solana address to receive payments

2. Install dependencies:
```bash
go mod download
```

3. Run the server:
```bash
go run main.go
```

## Testing the Server

You can test the server using one of the example clients:

### Using the Go HTTP Client
```bash
cd ../../clients/http
# Ensure .env is setup
go run main.go
```

These clients will demonstrate how to:
1. Make an initial request to get payment requirements
2. Process the payment requirements
3. Make a second request with the payment token

## Example Endpoint

The server includes a single example endpoint at `/weather` that accepts payment of 0.001 USDC on either Base Sepolia (EVM) or Solana Devnet (SVM). The endpoint returns a simple weather report.

## Response Format

### Payment Required (402)

```
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
PAYMENT-REQUIRED: <base64-encoded JSON>

null
```

The `PAYMENT-REQUIRED` header contains base64-encoded JSON with the payment requirements.
Note: `amount` is in atomic units (e.g., 1000 = 0.001 USDC, since USDC has 6 decimals):

```json
{
  "x402Version": 2,
  "error": "Payment required",
  "resource": {
    "url": "http://localhost:4021/weather",
    "description": "Get weather data for a city",
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
    },
    {
      "scheme": "exact",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "amount": "1000",
      "asset": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      "payTo": "...",
      "maxTimeoutSeconds": 300,
      "extra": {
        "feePayer": "...",
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

{"city":"San Francisco","weather":"foggy","temperature":60,"timestamp":"2025-01-01T12:00:00Z"}
```

The `PAYMENT-RESPONSE` header contains base64-encoded JSON with the settlement details:

```json
{
  "success": true,
  "transaction": "0x...",
  "network": "eip155:84532",
  "payer": "0x..."
}
```

## Extending the Example

To add more paid endpoints, follow this pattern:

```go
// First, configure the payment middleware with your routes
routes := x402http.RoutesConfig{
    "GET /your-endpoint": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                PayTo:   evmPayeeAddress,
                Price:   "$0.10",
                Network: x402.Network("eip155:84532"),
            },
        },
        Description: "Your endpoint description",
        MimeType:    "application/json",
    },
}

r.Use(ginmw.X402Payment(ginmw.Config{
    Routes:      routes,
    Facilitator: facilitatorClient,
    Schemes: []ginmw.SchemeConfig{
        {Network: x402.Network("eip155:*"), Server: evm.NewExactEvmScheme()},
    },
    Timeout: 30 * time.Second,
}))

// Then define your routes as normal
r.GET("/your-endpoint", func(c *gin.Context) {
    c.JSON(http.StatusOK, gin.H{
        // Your response data
    })
})
```

**Network identifiers** use [CAIP-2](https://github.com/ChainAgnostic/CAIPs/blob/main/CAIPs/caip-2.md) format, for example:
- `eip155:84532` — Base Sepolia
- `eip155:8453` — Base Mainnet
- `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1` — Solana Devnet
- `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` — Solana Mainnet

## x402ResourceServer Config

The middleware uses scheme registrations to declare how payments for each network should be processed:

```go
r.Use(ginmw.X402Payment(ginmw.Config{
    Routes:      routes,
    Facilitator: facilitatorClient,
    Schemes: []ginmw.SchemeConfig{
        {Network: x402.Network("eip155:*"), Server: evm.NewExactEvmScheme()},  // All EVM chains
        // {Network: x402.Network("solana:*"), Server: svm.NewExactSvmScheme()}, // All SVM chains
    },
    Timeout:    30 * time.Second,
}))
```

## Facilitator Config

The `HTTPFacilitatorClient` connects to a facilitator service that verifies and settles payments on-chain:

```go
facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
    URL: facilitatorURL,
})

// Or use multiple facilitators for redundancy
facilitatorClients := []x402.FacilitatorClient{
    x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{URL: primaryFacilitatorURL}),
    x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{URL: backupFacilitatorURL}),
}
```

## Next Steps

See [Advanced Examples](../advanced/) for:
- **Bazaar discovery** — make your API discoverable
- **Dynamic pricing** — price based on request context
- **Dynamic payTo** — route payments to different recipients
- **Lifecycle hooks** — custom logic on verify/settle
- **Custom tokens** — accept payments in custom tokens

## Related Resources

- [Gin Documentation](https://gin-gonic.com/docs/)
- [x402 Go Package Documentation](../../../../go/)
- [Client Examples](../../clients/) — build clients that can make paid requests
