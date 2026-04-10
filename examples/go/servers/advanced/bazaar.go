package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/bazaar"
	"github.com/x402-foundation/x402/go/extensions/types"
	x402http "github.com/x402-foundation/x402/go/http"
	ginmw "github.com/x402-foundation/x402/go/http/gin"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

const DefaultPort = "4021"

/**
 * Bazaar Discovery Extension Example
 *
 * This example demonstrates how to add the Bazaar discovery extension
 * to make your x402-protected API discoverable by clients and facilitators.
 * The extension includes input/output schemas and examples.
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
	 * Create Bazaar Discovery Extension
	 *
	 * This extension provides machine-readable API documentation that allows
	 * clients to discover what parameters your API accepts and what it returns.
	 */
	discoveryExtension, err := bazaar.DeclareDiscoveryExtension(
		bazaar.MethodGET,
		map[string]interface{}{"city": "San Francisco"}, // Example query params
		types.JSONSchema{
			"properties": map[string]interface{}{
				"city": map[string]interface{}{
					"type":        "string",
					"description": "City name to get weather for",
				},
			},
			"required": []string{"city"},
		},
		"", // No body for GET request
		&types.OutputConfig{
			Example: map[string]interface{}{
				"city":        "San Francisco",
				"weather":     "foggy",
				"temperature": 60,
			},
			Schema: types.JSONSchema{
				"properties": map[string]interface{}{
					"city":        map[string]interface{}{"type": "string"},
					"weather":     map[string]interface{}{"type": "string"},
					"temperature": map[string]interface{}{"type": "number"},
				},
				"required": []string{"city", "weather", "temperature"},
			},
		},
	)
	if err != nil {
		fmt.Printf("❌ Failed to create bazaar extension: %v\n", err)
		os.Exit(1)
	}

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
			Extensions: map[string]interface{}{
				types.BAZAAR: discoveryExtension,
			},
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
		city := c.DefaultQuery("city", "San Francisco")

		weatherData := map[string]map[string]interface{}{
			"San Francisco": {"weather": "foggy", "temperature": 60},
			"New York":      {"weather": "cloudy", "temperature": 55},
		}

		data, exists := weatherData[city]
		if !exists {
			data = map[string]interface{}{"weather": "sunny", "temperature": 70}
		}

		c.JSON(http.StatusOK, ginfw.H{
			"city":        city,
			"weather":     data["weather"],
			"temperature": data["temperature"],
		})
	})

	fmt.Printf("🚀 Bazaar Discovery example running on http://localhost:%s\n", DefaultPort)
	fmt.Printf("   The /weather endpoint is discoverable via Bazaar\n")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
