# x402 Gin Middleware

Gin middleware integration for the x402 Payment Protocol. This package provides middleware for adding x402 payment requirements to your Gin applications.

## Installation

```bash
go get github.com/coinbase/x402/go
```

## Quick Start

```go
package main

import (
	"time"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	ginmw "github.com/coinbase/x402/go/http/gin"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()

	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: "https://facilitator.x402.org",
	})

	routes := x402http.RoutesConfig{
		"GET /protected": {
			Scheme:      "exact",
			PayTo:       "0xYourAddress",
			Price:       "$0.10",
			Network:     "eip155:84532",
			Description: "Access to premium content",
		},
	}

	r.Use(ginmw.PaymentMiddlewareFromConfig(routes,
		ginmw.WithFacilitatorClient(facilitator),
		ginmw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	))

	r.GET("/protected", func(c *gin.Context) {
		c.JSON(200, gin.H{"message": "This content is behind a paywall"})
	})

	r.Run(":8080")
}
```

## Configuration

There are two approaches to configuring the middleware:

### 1. PaymentMiddlewareFromConfig (Functional Options)

Use `PaymentMiddlewareFromConfig` with functional options:

```go
r.Use(ginmw.PaymentMiddlewareFromConfig(routes,
	ginmw.WithFacilitatorClient(facilitator),
	ginmw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
))
```

### 2. PaymentMiddleware with Pre-configured Server

Use `PaymentMiddleware` when you need to configure the server separately (e.g., with lifecycle hooks):

```go
server := x402.Newx402ResourceServer(
	x402.WithFacilitatorClient(facilitator),
).
	Register("eip155:*", evm.NewExactEvmScheme()).
	OnAfterSettle(func(ctx x402.SettleResultContext) error {
		log.Printf("Payment settled: %s", ctx.Result.Transaction)
		return nil
	})

r.Use(ginmw.PaymentMiddleware(routes, server))
```

### Middleware Options

- `WithFacilitatorClient(client)` - Add a facilitator client
- `WithScheme(network, server)` - Register a payment scheme
- `WithPaywallConfig(config)` - Configure paywall UI
- `WithSyncFacilitatorOnStart(bool)` - Sync with facilitator on startup (default: true)
- `WithTimeout(duration)` - Set payment operation timeout (default: 30s)
- `WithErrorHandler(handler)` - Custom error handler
- `WithSettlementHandler(handler)` - Settlement callback

## Route Configuration

Define which routes require payment:

```go
routes := x402http.RoutesConfig{
	"GET /api/data": {
		Scheme:      "exact",
		PayTo:       "0xYourAddress",
		Price:       "$0.10",
		Network:     "eip155:84532",
		Description: "API data access",
	},
	"POST /api/compute": {
		Scheme:      "exact",
		PayTo:       "0xYourAddress",
		Price:       "$1.00",
		Network:     "eip155:8453",
		Description: "Compute operation",
	},
}
```

Routes support wildcards:
- `"GET /api/premium/*"` - Matches all GET requests under `/api/premium/`
- `"* /api/data"` - Matches all HTTP methods to `/api/data`

## Paywall Configuration

Configure the paywall UI for browser requests:

```go
paywallConfig := &x402http.PaywallConfig{
	AppName: "My API Service",
	AppLogo: "https://myapp.com/logo.svg",
	Testnet: true,
}

r.Use(ginmw.PaymentMiddlewareFromConfig(routes,
	ginmw.WithFacilitatorClient(facilitator),
	ginmw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	ginmw.WithPaywallConfig(paywallConfig),
))
```

The paywall includes:
- EVM wallet support (MetaMask, Coinbase Wallet, etc.)
- Solana wallet support (Phantom, Solflare, etc.)
- USDC balance checking and chain switching
- Onramp integration for mainnet

## Advanced Usage

### Multiple Payment Schemes

Register schemes for different networks:

```go
import (
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	svm "github.com/coinbase/x402/go/mechanisms/svm/exact/server"
)

r.Use(ginmw.PaymentMiddlewareFromConfig(routes,
	ginmw.WithFacilitatorClient(facilitator),
	ginmw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	ginmw.WithScheme("solana:*", svm.NewExactSvmScheme()),
))
```

### Custom Facilitator Client

Configure with custom authentication:

```go
facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
	URL: "https://your-facilitator.com",
	CreateAuthHeaders: func() (*x402http.FacilitatorAuthHeaders, error) {
		return &x402http.FacilitatorAuthHeaders{
			Verify: map[string]string{"Authorization": "Bearer verify-token"},
			Settle: map[string]string{"Authorization": "Bearer settle-token"},
		}, nil
	},
})
```

### Settlement Handler

Track successful payments:

```go
r.Use(ginmw.PaymentMiddlewareFromConfig(routes,
	ginmw.WithFacilitatorClient(facilitator),
	ginmw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	ginmw.WithSettlementHandler(func(c *gin.Context, settlement *x402.SettleResponse) {
		log.Printf("Payment settled - Payer: %s, Tx: %s",
			settlement.Payer,
			settlement.Transaction,
		)
		c.Header("X-Payment-Receipt", settlement.Transaction)
	}),
))
```

### Settlement Overrides (Upto Scheme)

For the upto scheme, route handlers specify the actual settlement amount via `SetSettlementOverrides`:

```go
r.GET("/api/metered", func(c *gin.Context) {
	usage := calculateUsage(c)
	ginmw.SetSettlementOverrides(c, &x402.SettlementOverrides{Amount: usage})

	c.JSON(http.StatusOK, gin.H{"result": "ok"})
})
```

### Error Handler

Custom error handling:

```go
r.Use(ginmw.PaymentMiddlewareFromConfig(routes,
	ginmw.WithFacilitatorClient(facilitator),
	ginmw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	ginmw.WithErrorHandler(func(c *gin.Context, err error) {
		log.Printf("Payment error: %v", err)
		c.JSON(http.StatusPaymentRequired, gin.H{
			"error": err.Error(),
		})
	}),
))
```

## Complete Example

```go
package main

import (
	"log"
	"time"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	ginmw "github.com/coinbase/x402/go/http/gin"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	"github.com/gin-gonic/gin"
)

func main() {
	r := gin.Default()

	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: "https://facilitator.x402.org",
	})

	routes := x402http.RoutesConfig{
		"GET /api/data": {
			Scheme:      "exact",
			PayTo:       "0xYourAddress",
			Price:       "$0.10",
			Network:     "eip155:84532",
			Description: "Basic data access",
		},
		"POST /api/compute": {
			Scheme:      "exact",
			PayTo:       "0xYourAddress",
			Price:       "$1.00",
			Network:     "eip155:8453",
			Description: "Compute operation",
		},
	}

	paywallConfig := &x402http.PaywallConfig{
		AppName: "My API Service",
		AppLogo: "/logo.svg",
		Testnet: true,
	}

	r.Use(ginmw.PaymentMiddlewareFromConfig(routes,
		ginmw.WithFacilitatorClient(facilitator),
		ginmw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
		ginmw.WithPaywallConfig(paywallConfig),
		ginmw.WithTimeout(60*time.Second),
		ginmw.WithSettlementHandler(func(c *gin.Context, settlement *x402.SettleResponse) {
			log.Printf("✅ Payment settled: %s", settlement.Transaction)
		}),
	))

	r.GET("/api/data", func(c *gin.Context) {
		c.JSON(200, gin.H{"data": "Protected content"})
	})

	r.POST("/api/compute", func(c *gin.Context) {
		c.JSON(200, gin.H{"result": "Computation complete"})
	})

	r.GET("/", func(c *gin.Context) {
		c.JSON(200, gin.H{"message": "Welcome"})
	})

	r.Run(":8080")
}
```

## Convenience Functions

### X402Payment (Config Struct)

With struct-based configuration:

```go
r.Use(ginmw.X402Payment(ginmw.Config{
	Routes:      routes,
	Facilitator: facilitator,
	Schemes:     []ginmw.SchemeConfig{{Network: "eip155:*", Server: evm.NewExactEvmScheme()}},
	Timeout:     30 * time.Second,
}))
```

### SimplePaymentMiddleware

Apply payment requirements to all routes:

```go
r.Use(ginmw.SimplePaymentMiddleware(
	"0xYourAddress",
	"$0.10",
	"eip155:84532",
	"https://facilitator.x402.org",
))
```