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
 * Dynamic Price Example
 *
 * This example demonstrates how to use dynamic pricing to charge different
 * amounts based on the request context. This is useful for implementing
 * tiered pricing, user-based pricing, or content-based pricing.
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
	 * Dynamic Price Function
	 *
	 * This function is called at request time to determine the price.
	 * It receives the full HTTP request context and can make decisions
	 * based on query parameters, headers, or any other request data.
	 */
	dynamicPrice := func(ctx context.Context, reqCtx x402http.HTTPRequestContext) (x402.Price, error) {
		// In a real implementation, you would extract the tier from query params
		// or headers using reqCtx.Adapter

		// For this example, we'll demonstrate the concept with a default tier
		tier := "standard" // default

		// You could extract tier from request like:
		// if reqCtx.Adapter != nil {
		//     tier = extractQueryParam(reqCtx.Adapter, "tier")
		// }

		var price x402.Price
		if tier == "premium" {
			price = "$0.005" // Premium tier: 0.5 cents
			fmt.Printf("💰 Premium tier pricing: %s\n", price)
		} else {
			price = "$0.001" // Standard tier: 0.1 cents
			fmt.Printf("💰 Standard tier pricing: %s\n", price)
		}

		return price, nil
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
		tier := c.DefaultQuery("tier", "standard")

		var response ginfw.H
		if tier == "premium" {
			// Premium tier gets detailed weather data
			response = ginfw.H{
				"report": ginfw.H{
					"weather":       "sunny",
					"temperature":   70,
					"humidity":      45,
					"windSpeed":     12,
					"precipitation": 0,
				},
			}
		} else {
			// Standard tier gets basic weather data
			response = ginfw.H{
				"report": ginfw.H{
					"weather":     "sunny",
					"temperature": 70,
				},
			}
		}

		c.JSON(http.StatusOK, response)
	})

	fmt.Printf("🚀 Dynamic Price example running on http://localhost:%s\n", DefaultPort)
	fmt.Printf("   Prices vary based on request context\n")
	fmt.Printf("   Try: ?tier=standard (cheaper) or ?tier=premium (more expensive)\n")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
