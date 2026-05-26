package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"time"

	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	ginmw "github.com/x402-foundation/x402/go/http/gin"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

const DefaultPort = "4021"

/**
 * Dynamic PayTo Example
 *
 * This example demonstrates how to use dynamic payTo resolution to
 * route payments to different addresses based on the request context.
 * This is useful for marketplace applications where payments should
 * go to different sellers/creators.
 */

func main() {
	godotenv.Load()

	evmPayeeAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	if evmPayeeAddress == "" {
		fmt.Println("❌ EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("❌ FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	evmNetwork := x402.Network("eip155:84532") // Base Sepolia

	r := ginfw.Default()

	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	/**
	 * Address Lookup Table
	 *
	 * In a real application, you would query a database for the appropriate
	 * payee address. Here we use a simple lookup table for demonstration.
	 */
	addressLookup := map[string]string{
		"US": evmPayeeAddress,
		"UK": evmPayeeAddress,
		"CA": evmPayeeAddress,
		"AU": evmPayeeAddress,
		"NZ": evmPayeeAddress,
		"IE": evmPayeeAddress,
		"FR": evmPayeeAddress,
	}

	/**
	 * Dynamic PayTo Function
	 *
	 * This function is called at request time to determine where the payment
	 * should be sent. It receives the full HTTP request context.
	 */
	dynamicPayTo := func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (string, error) {
		// Get the country from query parameter
		country := "US" // default
		if reqCtx.Adapter != nil {
			// In a real implementation, you'd extract query params from the adapter
			// For now, we'll use the default
		}

		address, ok := addressLookup[country]
		if !ok {
			address = evmPayeeAddress // fallback to default
		}

		fmt.Printf("💰 Routing payment for country=%s to address=%s\n", country, address)
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
			Description: "Weather data",
			MimeType:    "application/json",
		},
	}

	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []ginmw.SchemeConfig{
			{Network: evmNetwork, Server: evm.NewExactEvmScheme()},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}))

	r.GET("/weather", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{
			"report": ginfw.H{
				"weather":     "sunny",
				"temperature": 70,
			},
		})
	})

	fmt.Printf("🚀 Dynamic PayTo example running on http://localhost:%s\n", DefaultPort)
	fmt.Printf("   Payments are routed based on request context\n")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
