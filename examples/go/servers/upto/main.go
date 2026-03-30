package main

import (
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"time"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	ginmw "github.com/coinbase/x402/go/http/gin"
	uptoevm "github.com/coinbase/x402/go/mechanisms/evm/upto/server"
	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
)

const DefaultPort = "4021"

func main() {
	godotenv.Load()

	evmAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	if evmAddress == "" {
		fmt.Println("EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	evmNetwork := x402.Network("eip155:84532")

	fmt.Printf("Starting Gin x402 upto server...\n")
	fmt.Printf("  EVM Payee address: %s\n", evmAddress)
	fmt.Printf("  EVM Network: %s\n", evmNetwork)
	fmt.Printf("  Facilitator: %s\n", facilitatorURL)

	r := ginfw.Default()

	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	maxPrice := "$0.10" // Maximum the client authorizes

	routes := x402http.RoutesConfig{
		"GET /api/generate": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "upto",
					Price:   maxPrice,
					Network: evmNetwork,
					PayTo:   evmAddress,
				},
			},
			Description: "AI text generation - billed by token usage",
			MimeType:    "application/json",
		},
	}

	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []ginmw.SchemeConfig{
			{Network: evmNetwork, Server: uptoevm.NewUptoEvmScheme()},
		},
		Timeout: 30 * time.Second,
	}))

	r.GET("/api/generate", func(c *ginfw.Context) {
		// Simulate work that produces a variable cost.
		// In production this might be LLM token count, bytes served, compute time, etc.
		maxAmountAtomic := 100000 // 10 cents in 6-decimal USDC atomic units
		actualUsage := rand.Intn(maxAmountAtomic + 1)

		// Tell the middleware to settle only what was actually used.
		ginmw.SetSettlementOverrides(c, &x402.SettlementOverrides{
			Amount: fmt.Sprintf("%d", actualUsage),
		})

		c.JSON(http.StatusOK, ginfw.H{
			"result": "Here is your generated text...",
			"usage": ginfw.H{
				"authorizedMaxAtomic": fmt.Sprintf("%d", maxAmountAtomic),
				"actualChargedAtomic": fmt.Sprintf("%d", actualUsage),
			},
		})
	})

	r.GET("/health", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{
			"status":  "ok",
			"version": "2.0.0",
		})
	})

	fmt.Printf("  Server listening on http://localhost:%s\n\n", DefaultPort)
	fmt.Println("  GET /api/generate  - usage-based billing via upto scheme")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
