# x402 Echo Middleware

Echo middleware integration for the x402 Payment Protocol. This package provides middleware for adding x402 payment requirements to your Echo applications.

## Installation

```bash
go get github.com/coinbase/x402/go
```

## Quick Start

```go
package main

import (
	x402http "github.com/coinbase/x402/go/http"
	echomw "github.com/coinbase/x402/go/http/echo"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	"github.com/labstack/echo/v4"
)

func main() {
	e := echo.New()

	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: "https://facilitator.x402.org",
	})

	routes := x402http.RoutesConfig{
		"GET /protected": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xYourAddress",
					Price:   "$0.10",
					Network: "eip155:84532",
				},
			},
			Description: "Access to premium content",
		},
	}

	e.Use(echomw.PaymentMiddlewareFromConfig(routes,
		echomw.WithFacilitatorClient(facilitator),
		echomw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	))

	e.GET("/protected", func(c echo.Context) error {
		return c.JSON(200, map[string]interface{}{"message": "This content is behind a paywall"})
	})

	e.Logger.Fatal(e.Start(":8080"))
}
```

## Configuration

There are two approaches to configuring the middleware:

### 1. PaymentMiddlewareFromConfig (Functional Options)

Use `PaymentMiddlewareFromConfig` with functional options:

```go
e.Use(echomw.PaymentMiddlewareFromConfig(routes,
	echomw.WithFacilitatorClient(facilitator),
	echomw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
))
```

### 2. PaymentMiddlewareFromHTTPServer (Pre-configured Server)

Use `PaymentMiddlewareFromHTTPServer` when you need to configure the server separately (e.g., with lifecycle hooks):

```go
server := x402.Newx402ResourceServer(
	x402.WithFacilitatorClient(facilitator),
).
	Register("eip155:*", evm.NewExactEvmScheme()).
	OnAfterSettle(func(ctx x402.SettleResultContext) error {
		log.Printf("Payment settled: %s", ctx.Result.Transaction)
		return nil
	})

httpServer := x402http.Wrappedx402HTTPResourceServer(routes, server)

e.Use(echomw.PaymentMiddlewareFromHTTPServer(httpServer))
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
		Accepts: x402http.PaymentOptions{
			{
				Scheme:  "exact",
				PayTo:   "0xYourAddress",
				Price:   "$0.10",
				Network: "eip155:84532",
			},
		},
		Description: "API data access",
	},
	"POST /api/compute": {
		Accepts: x402http.PaymentOptions{
			{
				Scheme:  "exact",
				PayTo:   "0xYourAddress",
				Price:   "$1.00",
				Network: "eip155:8453",
			},
		},
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

e.Use(echomw.PaymentMiddlewareFromConfig(routes,
	echomw.WithFacilitatorClient(facilitator),
	echomw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	echomw.WithPaywallConfig(paywallConfig),
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

e.Use(echomw.PaymentMiddlewareFromConfig(routes,
	echomw.WithFacilitatorClient(facilitator),
	echomw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	echomw.WithScheme("solana:*", svm.NewExactSvmScheme()),
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
e.Use(echomw.PaymentMiddlewareFromConfig(routes,
	echomw.WithFacilitatorClient(facilitator),
	echomw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	echomw.WithSettlementHandler(func(c echo.Context, settlement *x402.SettleResponse) {
		log.Printf("Payment settled - Payer: %s, Tx: %s",
			settlement.Payer,
			settlement.Transaction,
		)
		c.Response().Header().Set("X-Payment-Receipt", settlement.Transaction)
	}),
))
```

### Settlement Overrides (Upto Scheme)

For the upto scheme, route handlers specify the actual settlement amount via `SetSettlementOverrides`:

```go
e.GET("/api/metered", func(c echo.Context) error {
	usage := calculateUsage(c)
	echomw.SetSettlementOverrides(c, &x402.SettlementOverrides{Amount: usage})

	return c.JSON(http.StatusOK, map[string]interface{}{"result": "ok"})
})
```

### Error Handler

Custom error handling:

```go
e.Use(echomw.PaymentMiddlewareFromConfig(routes,
	echomw.WithFacilitatorClient(facilitator),
	echomw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
	echomw.WithErrorHandler(func(c echo.Context, err error) {
		log.Printf("Payment error: %v", err)
		c.JSON(http.StatusPaymentRequired, map[string]interface{}{
			"error": err.Error(),
		})
	}),
))
```

## Convenience Functions

### X402Payment (Config Struct)

With struct-based configuration:

```go
e.Use(echomw.X402Payment(echomw.Config{
	Routes:      routes,
	Facilitator: facilitator,
	Schemes:     []echomw.SchemeConfig{{Network: "eip155:*", Server: evm.NewExactEvmScheme()}},
	Timeout:     30 * time.Second,
}))
```

### SimpleX402Payment

Apply payment requirements to all routes:

```go
e.Use(echomw.SimpleX402Payment(
	"0xYourAddress",
	"$0.10",
	"eip155:84532",
	"https://facilitator.x402.org",
))
```

## Complete Example

```go
package main

import (
	"log"
	"net/http"
	"time"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	echomw "github.com/coinbase/x402/go/http/echo"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	"github.com/labstack/echo/v4"
)

func main() {
	e := echo.New()

	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: "https://facilitator.x402.org",
	})

	routes := x402http.RoutesConfig{
		"GET /api/data": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xYourAddress",
					Price:   "$0.10",
					Network: "eip155:84532",
				},
			},
			Description: "Basic data access",
		},
		"POST /api/compute": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xYourAddress",
					Price:   "$1.00",
					Network: "eip155:8453",
				},
			},
			Description: "Compute operation",
		},
	}

	paywallConfig := &x402http.PaywallConfig{
		AppName: "My API Service",
		AppLogo: "/logo.svg",
		Testnet: true,
	}

	e.Use(echomw.PaymentMiddlewareFromConfig(routes,
		echomw.WithFacilitatorClient(facilitator),
		echomw.WithScheme("eip155:*", evm.NewExactEvmScheme()),
		echomw.WithPaywallConfig(paywallConfig),
		echomw.WithTimeout(60*time.Second),
		echomw.WithSettlementHandler(func(c echo.Context, settlement *x402.SettleResponse) {
			log.Printf("Payment settled: %s", settlement.Transaction)
		}),
	))

	e.GET("/api/data", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "Protected content"})
	})

	e.POST("/api/compute", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"result": "Computation complete"})
	})

	e.GET("/", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"message": "Welcome"})
	})

	e.Logger.Fatal(e.Start(":8080"))
}
```
