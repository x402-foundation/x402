# x402-core Custom Server

Gin server demonstrating how to implement x402 payment handling manually without using pre-built middleware packages like `x402/go/http/gin`.

## Prerequisites

- Go 1.24 or higher
- Valid EVM address for receiving payments
- URL of a facilitator supporting the desired payment network, see [facilitator list](https://www.x402.org/ecosystem?category=facilitators)

## Setup

1. Create a `.env` file with required environment variables:

```bash
FACILITATOR_URL=https://x402.org/facilitator
EVM_PAYEE_ADDRESS=0x742d35Cc6634C0532925a3b844Bc9e7595f0bEb
```

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

### Using the Custom Client

```bash
cd ../../clients/custom
# Ensure .env is setup
go run main.go
```

These clients will demonstrate how to:

1. Make an initial request to get payment requirements
2. Process the payment requirements
3. Make a second request with the payment token

## Example Endpoint

The server includes a single example endpoint at `/weather` that requires a payment of 0.001 USDC on Base Sepolia to access. The endpoint returns weather data for a given city.

## HTTP Headers

### Request Headers

When submitting payment, include one of these headers (both are supported for backwards compatibility):

| Header              | Protocol | Description                         |
| ------------------- | -------- | ----------------------------------- |
| `PAYMENT-SIGNATURE` | v2       | Base64-encoded JSON payment payload |
| `X-PAYMENT`         | v1       | Base64-encoded JSON payment payload |

Example request with payment:

```
GET /weather HTTP/1.1
Host: localhost:4021
PAYMENT-SIGNATURE: eyJwYXltZW50IjoiLi4uIn0=
```

### Response Headers

| Header             | Status | Description                                   |
| ------------------ | ------ | --------------------------------------------- |
| `PAYMENT-REQUIRED` | 402    | Base64-encoded JSON with payment requirements |
| `PAYMENT-RESPONSE` | 200    | Base64-encoded JSON with settlement details   |

## Response Format

### Payment Required (402)

```
HTTP/1.1 402 Payment Required
Content-Type: application/json; charset=utf-8
PAYMENT-REQUIRED: <base64-encoded JSON>

null
```

The `PAYMENT-REQUIRED` header contains base64-encoded JSON with the payment requirements:

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
    }
  ]
}
```

### Successful Response (with payment)

```
HTTP/1.1 200 OK
Content-Type: application/json; charset=utf-8
PAYMENT-RESPONSE: <base64-encoded JSON>

{"city":"San Francisco","weather":"foggy","temperature":60,"timestamp":"2024-01-01T12:00:00Z"}
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

## Payment Flow

The custom implementation demonstrates each step of the x402 payment flow:

1. **Request Arrives** — Middleware intercepts all requests
2. **Route Check** — Determine if route requires payment
3. **Payment Check** — Look for `PAYMENT-SIGNATURE` or `X-PAYMENT` header
4. **Decision Point**:
   - **No Payment**: Return 402 with requirements in `PAYMENT-REQUIRED` header
   - **Payment Provided**: Verify with facilitator
5. **Verification** — Check payment signature and validity
6. **Handler Execution** — Run protected endpoint handler
7. **Settlement** — Settle payment on-chain (for 2xx responses)
8. **Response** — Add settlement details in `PAYMENT-RESPONSE` header

## Key Implementation Details

### Defining Payment Requirements

```go
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
        Description: "Get weather data for a city",
        MimeType:    "application/json",
    },
}
```

### Creating the x402 Server

```go
x402Server := x402http.Newx402HTTPResourceServer(
    routes,
    x402.WithFacilitatorClient(facilitatorClient),
    x402.WithSchemeServer(evmNetwork, evm.NewExactEvmScheme()),
)

if err := x402Server.Initialize(ctx); err != nil {
    fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
}
```

### Processing Requests

```go
result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

switch result.Type {
case x402http.ResultNoPaymentRequired:
    // No payment required, continue to handler
    c.Next()

case x402http.ResultPaymentError:
    // Payment required but not provided or invalid
    handlePaymentError(c, result.Response)

case x402http.ResultPaymentVerified:
    // Payment verified, continue with settlement handling
    handlePaymentVerified(c, server, ctx, result)
}
```

### Settling Payment

```go
settlementHeaders, err := server.ProcessSettlement(
    ctx,
    *result.PaymentPayload,
    *result.PaymentRequirements,
    capture.statusCode,
)

if err != nil {
    c.JSON(http.StatusInternalServerError, gin.H{
        "error":   "Settlement failed",
        "details": err.Error(),
    })
    return
}

// Add settlement headers to response
for key, value := range settlementHeaders {
    c.Header(key, value)
}
```

## Middleware vs Custom Comparison

| Aspect                 | With Middleware (ginmw) | Custom Implementation |
| ---------------------- | ----------------------- | --------------------- |
| Code Complexity        | ~10 lines               | ~400 lines            |
| Automatic Verification | ✅ Yes                  | ❌ Manual             |
| Automatic Settlement   | ✅ Yes                  | ❌ Manual             |
| Header Management      | ✅ Automatic            | ❌ Manual             |
| Flexibility            | Limited                 | ✅ Complete control   |
| Error Handling         | ✅ Built-in             | ❌ You implement      |
| Maintenance            | x402 team               | You maintain          |

## When to Use Each Approach

**Use Middleware (x402/go/http/gin) when:**

- Building standard applications
- Want quick integration
- Prefer automatic payment handling
- Using supported frameworks (Gin)

**Use Custom Implementation when:**

- Using unsupported frameworks (chi, Fiber, etc.)
- Need complete control over flow
- Require custom error handling
- Want to understand internals
- Building custom abstractions

## Adapting to Other Frameworks

To use this pattern with other frameworks:

1. Implement the `x402http.HTTPAdapter` interface for your framework
2. Create a middleware function that uses `server.ProcessHTTPRequest()`
3. Handle the three result types: `NoPaymentRequired`, `PaymentError`, `PaymentVerified`
4. Use `server.ProcessSettlement()` to settle payments after successful responses

The pattern in `main.go` can be adapted to any Go web framework.
