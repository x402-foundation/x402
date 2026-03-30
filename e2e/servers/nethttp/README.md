# E2E Test Server: net/http (Go)

This server demonstrates and tests the x402 net/http middleware with both EVM and SVM payment protection.

## What It Tests

### Core Functionality
- ✅ **V2 Protocol** - Modern x402 server middleware
- ✅ **Payment Protection** - Middleware protecting specific routes
- ✅ **Multi-chain Support** - EVM and SVM payment acceptance
- ✅ **Facilitator Integration** - HTTP communication with facilitator
- ✅ **Extension Support** - Bazaar discovery metadata
- ✅ **Settlement Handling** - Payment verification and confirmation

### Protected Endpoints
- ✅ `GET /protected` - Requires EVM payment (USDC on Base Sepolia)
- ✅ `GET /protected-svm` - Requires SVM payment (USDC on Solana Devnet)

## What It Demonstrates

### Server Setup

```go
import (
    "net/http"
    x402 "github.com/coinbase/x402/go"
    x402http "github.com/coinbase/x402/go/http"
    nethttpmw "github.com/coinbase/x402/go/http/nethttp"
    evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
    svm "github.com/coinbase/x402/go/mechanisms/svm/exact/server"
    "github.com/coinbase/x402/go/extensions/bazaar"
)

// Create ServeMux
mux := http.NewServeMux()

// Define payment routes
routes := x402http.RoutesConfig{
    "GET /protected": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                Network: "eip155:84532",
                PayTo:   evmPayeeAddress,
                Price:   "$0.001",
            },
        },
        Extensions: map[string]interface{}{
            "bazaar": discoveryExtension,
        },
    },
    "GET /protected-svm": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                Network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
                PayTo:   svmPayeeAddress,
                Price:   "$0.001",
            },
        },
        Extensions: map[string]interface{}{
            "bazaar": discoveryExtension,
        },
    },
}

// Define protected endpoints
mux.HandleFunc("GET /protected", func(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]string{"message": "EVM payment successful!"})
})

mux.HandleFunc("GET /protected-svm", func(w http.ResponseWriter, r *http.Request) {
    json.NewEncoder(w).Encode(map[string]string{"message": "SVM payment successful!"})
})

// Apply payment middleware
handler := nethttpmw.X402Payment(nethttpmw.Config{
    Routes:      routes,
    Facilitator: facilitatorClient,
    Schemes: []nethttpmw.SchemeConfig{
        {Network: "eip155:84532", Server: evm.NewExactEvmScheme()},
        {Network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", Server: svm.NewExactSvmScheme()},
    },
    Timeout: 30 * time.Second,
})(mux)

http.ListenAndServe(":4021", handler)
```

### Key Concepts Shown

1. **Route Configuration** - Map of route → payment requirements
2. **Multi-Chain Services** - Different services for EVM vs SVM
3. **Facilitator Client** - HTTP client for verification/settlement
4. **Middleware Options** - Functional options pattern
5. **Extension Integration** - Bazaar discovery declarations
6. **Automatic Initialization** - Service initialization on startup

## Test Scenarios

This server is tested with:
- **Clients:** TypeScript Fetch, Go HTTP
- **Facilitators:** TypeScript, Go
- **Payment Types:** EVM (Base Sepolia), SVM (Solana Devnet)
- **Protocols:** V2 (primary), V1 (via client negotiation)

### Request Flow
1. Client makes initial request (no payment)
2. Middleware returns 402 with `PAYMENT-REQUIRED` header
3. Client creates payment payload
4. Client retries with `PAYMENT-SIGNATURE` header
5. Middleware forwards to facilitator for verification
6. Middleware returns protected content + `PAYMENT-RESPONSE` header

## Running

```bash
# Via e2e test suite
cd e2e
pnpm test --server=nethttp

# Direct execution
cd e2e/servers/nethttp
export FACILITATOR_URL="http://localhost:4024"
export EVM_PAYEE_ADDRESS="0x..."
export SVM_PAYEE_ADDRESS="..."
export PORT=4023
./nethttp
```

## Environment Variables

- `PORT` - HTTP server port (default: 4021)
- `FACILITATOR_URL` - Facilitator endpoint URL
- `EVM_PAYEE_ADDRESS` - Ethereum address to receive payments
- `SVM_PAYEE_ADDRESS` - Solana address to receive payments
- `EVM_NETWORK` - EVM network (default: eip155:84532)
- `SVM_NETWORK` - SVM network (default: solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)

## Response Examples

### 402 Payment Required

```
HTTP/1.1 402 Payment Required
PAYMENT-REQUIRED: <base64-encoded-requirements>
Content-Type: application/json

{
  "error": "Payment required",
  "x402Version": 2,
  "accepts": [...],
  "resource": {...},
  "extensions": {
    "bazaar": {
      "method": "GET",
      "outputExample": {...}
    }
  }
}
```

### 200 Success (After Payment)

```
HTTP/1.1 200 OK
PAYMENT-RESPONSE: <base64-encoded-settlement>
Content-Type: application/json

{
  "message": "Protected endpoint accessed successfully",
  "timestamp": "2024-01-01T00:00:00Z"
}
```

## Dependencies

- `github.com/coinbase/x402/go` - Core x402
- `github.com/coinbase/x402/go/http` - HTTP integration
- `github.com/coinbase/x402/go/http/nethttp` - net/http middleware
- `github.com/coinbase/x402/go/mechanisms/evm` - EVM server
- `github.com/coinbase/x402/go/mechanisms/svm` - SVM server
- `github.com/coinbase/x402/go/extensions/bazaar` - Discovery extension

## Implementation Highlights

### Middleware Features
- **Route Matching** - Pattern-based route configuration
- **Payment Requirement Building** - Automatic 402 response generation
- **Facilitator Communication** - HTTP client for verification
- **Settlement Callbacks** - Optional handlers for payment events
- **Extension Support** - Bazaar metadata in responses
- **Timeout Handling** - Configurable facilitator timeouts

### Service Integration
- **EVM Server** - Base Sepolia USDC
- **SVM Server** - Solana Devnet USDC
- **Initialization** - Fetches supported kinds from facilitator
- **Price Parsing** - Dollar strings → token amounts

### Bazaar Extension
- **Method Declaration** - GET with output schema
- **Example Output** - Response structure preview
- **Schema Definition** - JSON Schema for validation
