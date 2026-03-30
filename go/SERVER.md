# x402 Go Server Documentation

This guide covers how to build payment-accepting servers in Go using the x402 package.

## Overview

An **x402 server** is an application that protects HTTP resources with payment requirements. The server:

1. Defines which routes require payment
2. Returns 402 Payment Required for unpaid requests
3. Verifies payment signatures (via facilitator)
4. Settles payments on-chain (via facilitator)
5. Returns the protected resource after successful payment

## Quick Start

### Installation

```bash
go get github.com/coinbase/x402/go
```

### Basic Gin Server

```go
package main

import (
    "github.com/gin-gonic/gin"
    x402 "github.com/coinbase/x402/go"
    x402http "github.com/coinbase/x402/go/http"
    ginmw "github.com/coinbase/x402/go/http/gin"
    evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
)

func main() {
    r := gin.Default()
    
    // 1. Configure payment routes
    routes := x402http.RoutesConfig{
        "GET /data": {
            Accepts: x402http.PaymentOptions{
                {
                    Scheme:  "exact",
                    PayTo:   "0x...",
                    Price:   "$0.001",
                    Network: "eip155:84532",
                },
            },
            Description: "Get data",
            MimeType:    "application/json",
        },
    }
    
    // 2. Create facilitator client
    facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
        URL: "https://x402.org/facilitator",
    })
    
    // 3. Add payment middleware
    r.Use(ginmw.X402Payment(ginmw.Config{
        Routes:      routes,
        Facilitator: facilitator,
        Schemes: []ginmw.SchemeConfig{
            {Network: "eip155:84532", Server: evm.NewExactEvmScheme()},
        },
    }))
    
    // 4. Protected endpoint handler
    r.GET("/data", func(c *gin.Context) {
        c.JSON(200, gin.H{"result": "protected data"})
    })
    
    r.Run(":8080")
}
```

## Core Concepts

### 1. Route Configuration

Routes define payment requirements for specific endpoints.

```go
routes := x402http.RoutesConfig{
    "GET /resource": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",           // Payment scheme (exact, upto, etc.)
                PayTo:   "0x...",           // Payment recipient address
                Price:   "$0.001",          // Price in USD
                Network: "eip155:84532",    // Blockchain network
            },
        },
        Description: "Resource description",
        MimeType:    "application/json",
    },
}
```

#### Pattern Matching

Route keys use pattern matching:

```go
routes := x402http.RoutesConfig{
    "GET /exact-match":    {...},  // Exact path match
    "GET /users/*":        {...},  // Wildcard suffix
    "*":                   {...},  // All routes
}
```

### 2. Resource Server Core (x402.X402ResourceServer)

The core server manages payment verification and requirements.

**Key Methods:**

```go
server := x402.Newx402ResourceServer(
    x402.WithFacilitatorClient(facilitator),
    x402.WithSchemeServer(network, schemeServer),
)

// Build payment requirements for a resource
requirements, _ := server.BuildPaymentRequirements(ctx, config)

// Verify payment
verifyResult, _ := server.VerifyPayment(ctx, payload, requirements)

// Settle payment
settleResult, _ := server.SettlePayment(ctx, payload, requirements)
```

### 3. HTTP Integration

The HTTP layer adds request/response handling.

```go
// Create HTTP resource server
httpServer := x402http.Newx402HTTPResourceServer(
    routes,
    x402.WithFacilitatorClient(facilitator),
    x402.WithSchemeServer(network, schemeServer),
)

// Process HTTP requests
result := httpServer.ProcessHTTPRequest(ctx, reqCtx, nil)

// Handle settlement with transport context
settleResult := httpServer.ProcessSettlement(ctx, payload, requirements, nil, &x402http.HTTPTransportContext{
    Request:         &reqCtx,
    ResponseBody:    responseBody,
    ResponseHeaders: responseHeaders,
})
```

### 4. Facilitator Client

Servers use facilitator clients to verify and settle payments.

```go
facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
    URL: "https://x402.org/facilitator",
})

// Verify payment (called by middleware)
verifyResp, err := facilitator.Verify(ctx, payloadBytes, requirementsBytes)

// Settle payment (called by middleware)
settleResp, err := facilitator.Settle(ctx, payloadBytes, requirementsBytes)
```

## Middleware

### Gin Middleware

```go
import ginmw "github.com/coinbase/x402/go/http/gin"

r.Use(ginmw.X402Payment(ginmw.Config{
    Routes:      routes,
    Facilitator: facilitator,
    Schemes:     schemes,
    Timeout:     30 * time.Second,
}))
```

**Configuration Options:**

- `Routes` - Payment requirements per route
- `Facilitator` - Facilitator client for verification/settlement
- `Schemes` - Scheme servers to register
- `Initialize` - Query facilitator on startup
- `Timeout` - Context timeout for operations
- `ErrorHandler` - Custom error handling
- `SettlementHandler` - Called after successful settlement

### Custom Middleware

Implement custom middleware using the HTTP server directly:

```go
func customPaymentMiddleware(server *x402http.HTTPServer) gin.HandlerFunc {
    return func(c *gin.Context) {
        adapter := NewGinAdapter(c)
        reqCtx := x402http.HTTPRequestContext{
            Adapter: adapter,
            Path:    c.Request.URL.Path,
            Method:  c.Request.Method,
        }
        
        result := server.ProcessHTTPRequest(ctx, reqCtx, nil)
        
        switch result.Type {
        case x402http.ResultNoPaymentRequired:
            c.Next()
        case x402http.ResultPaymentError:
            // Return 402 with payment requirements
        case x402http.ResultPaymentVerified:
            // Continue and settle
        }
    }
}
```

See **[examples/go/servers/custom/](../../examples/go/servers/custom/)** for complete implementation.

## Advanced Features

### Dynamic Pricing

Charge different amounts based on request context:

```go
routes := x402http.RoutesConfig{
    "GET /data": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                PayTo:   "0x...",
                Network: "eip155:84532",
                Price: x402http.DynamicPriceFunc(func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (x402.Price, error) {
                    tier := extractTierFromRequest(reqCtx)
                    if tier == "premium" {
                        return "$0.005", nil
                    }
                    return "$0.001", nil
                }),
            },
        },
    },
}
```

### Dynamic PayTo

Route payments to different addresses:

```go
routes := x402http.RoutesConfig{
    "GET /marketplace/item/*": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                Price:   "$10.00",
                Network: "eip155:84532",
                PayTo: x402http.DynamicPayToFunc(func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (string, error) {
                    sellerID := extractSellerFromPath(reqCtx.Path)
                    return getSellerAddress(sellerID)
                }),
            },
        },
    },
}
```

### Custom Money Parser

Use alternative tokens for payments:

```go
evmScheme := evm.NewExactEvmScheme().RegisterMoneyParser(
    func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
        // Use DAI for large amounts
        if amount > 100 {
            return &x402.AssetAmount{
                Amount: fmt.Sprintf("%.0f", amount*1e18),
                Asset:  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI
                Extra:  map[string]interface{}{"token": "DAI"},
            }, nil
        }
        return nil, nil // Use default USDC for small amounts
    },
)
```

### Lifecycle Hooks

Run custom logic during payment processing:

```go
server := x402.Newx402ResourceServer(
    x402.WithFacilitatorClient(facilitator),
    x402.WithSchemeServer(network, schemeServer),
)

server.OnBeforeVerify(func(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
    log.Printf("Verifying payment for %s", ctx.Requirements.Network)
    return nil, nil
})

server.OnAfterSettle(func(ctx x402.SettleResultContext) error {
    log.Printf("Payment settled: %s", ctx.Result.Transaction)
    return nil
})
```

### Extensions

Add protocol extensions like Bazaar discovery:

```go
import (
    "github.com/coinbase/x402/go/extensions/bazaar"
    "github.com/coinbase/x402/go/extensions/types"
)

discoveryExt, _ := bazaar.DeclareDiscoveryExtension(
    bazaar.MethodGET,
    map[string]interface{}{"city": "San Francisco"},
    &types.InputConfig{...},
    "",
    &types.OutputConfig{...},
)

routes := x402http.RoutesConfig{
    "GET /weather": {
        Accepts: x402http.PaymentOptions{
            {Scheme: "exact", PayTo: "0x...", Price: "$0.001", Network: "eip155:84532"},
        },
        Extensions: map[string]interface{}{
            types.BAZAAR: discoveryExt,
        },
    },
}
```

## API Reference

### x402.X402ResourceServer

**Constructor:**
```go
func Newx402ResourceServer(opts ...ResourceServerOption) *X402ResourceServer
```

**Options:**
```go
func WithFacilitatorClient(client FacilitatorClient) ResourceServerOption
func WithSchemeServer(network Network, server SchemeNetworkServer) ResourceServerOption
```

**Hook Methods:**
```go
func (s *X402ResourceServer) OnBeforeVerify(hook BeforeVerifyHook) *X402ResourceServer
func (s *X402ResourceServer) OnAfterVerify(hook AfterVerifyHook) *X402ResourceServer
func (s *X402ResourceServer) OnVerifyFailure(hook OnVerifyFailureHook) *X402ResourceServer
func (s *X402ResourceServer) OnBeforeSettle(hook BeforeSettleHook) *X402ResourceServer
func (s *X402ResourceServer) OnAfterSettle(hook AfterSettleHook) *X402ResourceServer
func (s *X402ResourceServer) OnSettleFailure(hook OnSettleFailureHook) *X402ResourceServer
```

**Payment Methods:**
```go
func (s *X402ResourceServer) BuildPaymentRequirements(ctx context.Context, config ResourceConfig) ([]PaymentRequirements, error)
func (s *X402ResourceServer) VerifyPayment(ctx context.Context, payload PaymentPayload, requirements PaymentRequirements) (VerifyResponse, error)
func (s *X402ResourceServer) SettlePayment(ctx context.Context, payload PaymentPayload, requirements PaymentRequirements) (SettleResponse, error)
```

### x402http.RoutesConfig

```go
type RoutesConfig map[string]RouteConfig

type RouteConfig struct {
    Accepts     []PaymentOption         // Payment options for this route
    Description string                  // Resource description
    MimeType    string                  // Response content type
    Extensions  map[string]interface{}  // Protocol extensions
}

type PaymentOption struct {
    Scheme  string                  // "exact", etc.
    PayTo   interface{}             // string or DynamicPayToFunc
    Price   interface{}             // x402.Price or DynamicPriceFunc
    Network x402.Network            // "eip155:84532", etc.
}
```

### ginmw.Config

```go
type Config struct {
    Routes            RoutesConfig
    Facilitator       FacilitatorClient
    Facilitators      []FacilitatorClient
    Schemes           []SchemeConfig
    Initialize        bool
    Timeout           time.Duration
    ErrorHandler      func(*gin.Context, error)
    SettlementHandler func(*gin.Context, SettleResponse)
}
```

## Error Handling

### Custom Error Handler

```go
r.Use(ginmw.X402Payment(ginmw.Config{
    // ... config ...
    ErrorHandler: func(c *gin.Context, err error) {
        log.Printf("Payment error: %v", err)
        c.JSON(http.StatusPaymentRequired, gin.H{
            "error": "Payment failed",
            "details": err.Error(),
        })
    },
}))
```

### Settlement Handler

```go
r.Use(ginmw.X402Payment(ginmw.Config{
    // ... config ...
    SettlementHandler: func(c *gin.Context, resp x402.SettleResponse) {
        log.Printf("Payment settled: tx=%s, payer=%s", resp.Transaction, resp.Payer)
        
        // Store in database, emit metrics, etc.
        db.RecordPayment(resp.Transaction, resp.Payer)
    },
}))
```

## Best Practices

### 1. Initialize on Startup

Query facilitator capabilities during startup:

```go
r.Use(ginmw.X402Payment(ginmw.Config{
    SyncFacilitatorOnStart: true,  // Query /supported endpoint on start
    // ...
}))
```

### 2. Set Appropriate Timeouts

```go
r.Use(ginmw.X402Payment(ginmw.Config{
    Timeout: 30 * time.Second,  // Payment operations timeout
    // ...
}))
```

### 3. Use Descriptive Routes

```go
routes := x402http.RoutesConfig{
    "GET /api/weather": {
        Accepts: x402http.PaymentOptions{
            {Scheme: "exact", PayTo: "0x...", Price: "$0.001", Network: "eip155:84532"},
        },
        Description: "Get current weather data for a city",
        MimeType:    "application/json",
    },
}
```

### 4. Handle Both Success and Failure

```go
r.Use(ginmw.X402Payment(ginmw.Config{
    ErrorHandler: func(c *gin.Context, err error) {
        // Log and notify on errors
    },
    SettlementHandler: func(c *gin.Context, resp x402.SettleResponse) {
        // Record successful payments
    },
    // ...
}))
```

### 5. Protect Specific Routes

Don't protect everything:

```go
routes := x402http.RoutesConfig{
    // Protected
    "GET /api/premium":    {Accepts: x402http.PaymentOptions{{Price: "$1.00", ...}}},
    "POST /api/compute":   {Accepts: x402http.PaymentOptions{{Price: "$5.00", ...}}},
    // Leave /health, /docs, etc. unprotected
}
```

## Payment Flow

1. **Client Request** → Server receives request
2. **Route Matching** → Check if route requires payment
3. **Payment Check** → Look for payment headers
4. **Decision:**
   - **No payment required** → Continue to handler
   - **No payment provided** → Return 402 with requirements
   - **Payment provided** → Verify with facilitator
5. **Verification** → Facilitator checks signature validity
6. **Handler Execution** → Run protected endpoint
7. **Settlement** → Submit payment transaction on-chain
8. **Response** → Return resource with settlement headers

## Advanced Patterns

### Multiple Networks

Support payments on multiple blockchains:

```go
r.Use(ginmw.X402Payment(ginmw.Config{
    Routes: routes,
    Facilitator: facilitator,
    Schemes: []ginmw.SchemeConfig{
        {Network: "eip155:84532", Server: evm.NewExactEvmScheme()},
        {Network: "eip155:8453", Server: evm.NewExactEvmScheme()},
        {Network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", Server: svm.NewExactSvmScheme()},
    },
}))
```

### Per-Route Configuration

Different prices for different endpoints:

```go
routes := x402http.RoutesConfig{
    "GET /api/basic":       {Accepts: x402http.PaymentOptions{{Price: "$0.001", ...}}},   // Cheap
    "GET /api/premium":     {Accepts: x402http.PaymentOptions{{Price: "$0.10", ...}}},    // Medium
    "POST /api/compute":    {Accepts: x402http.PaymentOptions{{Price: "$1.00", ...}}},    // Expensive
}
```

### Tiered Pricing

Implement dynamic pricing based on request context:

```go
routes := x402http.RoutesConfig{
    "GET /api/data": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                PayTo:   "0x...",
                Network: "eip155:84532",
                Price: x402http.DynamicPriceFunc(func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (x402.Price, error) {
                    tier := getUserTier(reqCtx)
                    switch tier {
                    case "free":
                        return "$0.10", nil
                    case "premium":
                        return "$0.01", nil
                    case "enterprise":
                        return "$0.001", nil
                    default:
                        return "$0.10", nil
                    }
                }),
            },
        },
    },
}
```

### Marketplace Payment Routing

Route payments to different sellers:

```go
routes := x402http.RoutesConfig{
    "GET /marketplace/item/*": {
        Accepts: x402http.PaymentOptions{
            {
                Scheme:  "exact",
                Price:   "$10.00",
                Network: "eip155:84532",
                PayTo: x402http.DynamicPayToFunc(func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (string, error) {
                    itemID := extractItemID(reqCtx.Path)
                    seller, err := db.GetItemSeller(itemID)
                    if err != nil {
                        return "", err
                    }
                    return seller.WalletAddress, nil
                }),
            },
        },
    },
}
```

## Lifecycle Hooks

### Server-Side Hooks

```go
server.OnBeforeVerify(func(ctx VerifyContext) (*BeforeHookResult, error) {
    // Custom validation before verification
    log.Printf("Verifying payment from %s", ctx.Payload.Payer)
    return nil, nil
})

server.OnAfterSettle(func(ctx SettleResultContext) error {
    // Record transaction in database
    db.RecordPayment(ctx.Result.Transaction, ctx.Result.Payer)
    return nil
})
```

### Use Cases

**Database Logging:**
```go
server.OnAfterSettle(func(ctx SettleResultContext) error {
    return db.InsertPayment(Payment{
        Transaction: ctx.Result.Transaction,
        Payer:       ctx.Result.Payer,
        Network:     ctx.Result.Network,
        Amount:      ctx.Requirements.Amount,
        Timestamp:   time.Now(),
    })
})
```

**Metrics:**
```go
server.OnAfterVerify(func(ctx VerifyResultContext) error {
    metrics.IncrementCounter("payments.verified")
    return nil
})
```

**Access Control:**
```go
server.OnBeforeSettle(func(ctx SettleContext) (*BeforeHookResult, error) {
    if isBlacklisted(ctx.Payload.Payer) {
        return &BeforeHookResult{
            Abort: true,
            Reason: "Payer not allowed",
        }, nil
    }
    return nil, nil
})
```

## Testing

### Testing Protected Endpoints

```go
func TestProtectedEndpoint(t *testing.T) {
    // Create test server
    r := gin.Default()
    
    // Add mock middleware
    r.Use(mockPaymentMiddleware())
    
    r.GET("/protected", handler)
    
    // Test with valid payment
    req := httptest.NewRequest("GET", "/protected", nil)
    req.Header.Set("PAYMENT-SIGNATURE", validPayment)
    
    w := httptest.NewRecorder()
    r.ServeHTTP(w, req)
    
    if w.Code != 200 {
        t.Errorf("Expected 200, got %d", w.Code)
    }
}
```

### Integration Testing

See [`test/integration/`](test/integration/) for examples testing against real facilitators.

## Deployment Considerations

### Production Checklist

- [ ] Use production facilitator URL
- [ ] Set appropriate timeouts (30s recommended)
- [ ] Implement error and settlement handlers
- [ ] Monitor facilitator health
- [ ] Rate limit endpoints
- [ ] Log payment events
- [ ] Set up alerts for payment failures
- [ ] Use HTTPS in production

### Facilitator Selection

**Testnet:**
```go
facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
    URL: "https://x402.org/facilitator", // Testnet
})
```

**Mainnet:**
```go
facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
    URL: "https://facilitator.coinbase.com", // Production
})
```

**Self-Hosted:**
```go
facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
    URL: "https://your-facilitator.example.com",
})
```

## Examples

Complete examples are available in [`examples/go/servers/`](../../examples/go/servers/):

- **[Gin Server](../../examples/go/servers/gin/)** - Basic integration
- **[Custom Server](../../examples/go/servers/custom/)** - Custom middleware
- **[Advanced Patterns](../../examples/go/servers/advanced/)** - Dynamic pricing, hooks, extensions

## Migration from V1

### Route Configuration

**V1:**
```go
routes := x402gin.Routes{
    "GET /data": {
        Network: "base-sepolia",
        // ...
    },
}
```

**V2:**
```go
routes := x402http.RoutesConfig{
    "GET /data": {
        Network: "eip155:84532",  // CAIP-2 format
        // ...
    },
}
```

### Import Paths

**V1:**
```go
import "github.com/coinbase/x402/go/middleware/gin"
```

**V2:**
```go
import ginmw "github.com/coinbase/x402/go/http/gin"
```

## Related Documentation

- **[Main README](README.md)** - Package overview
- **[CLIENT.md](CLIENT.md)** - Building clients
- **[FACILITATOR.md](FACILITATOR.md)** - Building facilitators
- **[Mechanisms](mechanisms/)** - Payment scheme implementations
- **[Extensions](extensions/)** - Protocol extensions
- **[Examples](../../examples/go/servers/)** - Working server examples

