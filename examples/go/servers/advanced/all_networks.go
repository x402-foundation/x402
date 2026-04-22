package main

import (
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
	svm "github.com/x402-foundation/x402/go/mechanisms/svm/exact/server"
)

/**
 * All Networks Server Example
 *
 * Demonstrates how to create a server that supports all available networks with
 * optional chain configuration via environment variables.
 *
 * New chain support should be added here in alphabetic order by network prefix
 * (e.g., "eip155" before "solana").
 */

const (
	defaultPort = "4021"
)

func main() {
	godotenv.Load()

	// Configuration - optional per network
	evmAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	svmAddress := os.Getenv("SVM_PAYEE_ADDRESS")

	// Validate at least one address is provided
	if evmAddress == "" && svmAddress == "" {
		fmt.Println("❌ At least one of EVM_PAYEE_ADDRESS or SVM_PAYEE_ADDRESS is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("❌ FACILITATOR_URL environment variable is required")
		fmt.Println("   Example: https://x402.org/facilitator")
		os.Exit(1)
	}

	// Network configuration
	evmNetwork := x402.Network("eip155:84532")                            // Base Sepolia
	svmNetwork := x402.Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1") // Solana Devnet

	fmt.Printf("🚀 Starting All Networks Server...\n")
	if evmAddress != "" {
		fmt.Printf("   EVM Payee address: %s\n", evmAddress)
		fmt.Printf("   EVM Network: %s\n", evmNetwork)
	}
	if svmAddress != "" {
		fmt.Printf("   SVM Payee address: %s\n", svmAddress)
		fmt.Printf("   SVM Network: %s\n", svmNetwork)
	}
	fmt.Printf("   Facilitator: %s\n", facilitatorURL)

	// Create Gin router
	r := ginfw.Default()

	// Create HTTP facilitator client
	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	// Build accepts array dynamically based on configured addresses
	paymentOptions := x402http.PaymentOptions{}
	if evmAddress != "" {
		paymentOptions = append(paymentOptions, x402http.PaymentOption{
			Scheme:  "exact",
			Price:   "$0.001",
			Network: evmNetwork,
			PayTo:   evmAddress,
		})
	}
	if svmAddress != "" {
		paymentOptions = append(paymentOptions, x402http.PaymentOption{
			Scheme:  "exact",
			Price:   "$0.001",
			Network: svmNetwork,
			PayTo:   svmAddress,
		})
	}

	// Configure routes
	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts:     paymentOptions,
			Description: "Get weather data for a city",
			MimeType:    "application/json",
		},
	}

	// Build scheme config dynamically based on configured addresses
	schemes := []ginmw.SchemeConfig{}
	if evmAddress != "" {
		schemes = append(schemes, ginmw.SchemeConfig{
			Network: evmNetwork,
			Server:  evm.NewExactEvmScheme(),
		})
	}
	if svmAddress != "" {
		schemes = append(schemes, ginmw.SchemeConfig{
			Network: svmNetwork,
			Server:  svm.NewExactSvmScheme(),
		})
	}

	// Apply x402 payment middleware
	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes:     schemes,
		Timeout:     30 * time.Second,
	}))

	// Protected endpoint - requires payment
	r.GET("/weather", func(c *ginfw.Context) {
		city := c.DefaultQuery("city", "San Francisco")

		weatherData := map[string]map[string]interface{}{
			"San Francisco": {"weather": "foggy", "temperature": 60},
			"New York":      {"weather": "cloudy", "temperature": 55},
			"London":        {"weather": "rainy", "temperature": 50},
			"Tokyo":         {"weather": "clear", "temperature": 65},
		}

		data, exists := weatherData[city]
		if !exists {
			data = map[string]interface{}{"weather": "sunny", "temperature": 70}
		}

		c.JSON(http.StatusOK, ginfw.H{
			"city":        city,
			"weather":     data["weather"],
			"temperature": data["temperature"],
			"timestamp":   time.Now().Format(time.RFC3339),
		})
	})

	// Health check endpoint - no payment required
	r.GET("/health", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{
			"status":  "ok",
			"version": "2.0.0",
		})
	})

	fmt.Printf("   Server listening on http://localhost:%s\n\n", defaultPort)

	if err := r.Run(":" + defaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
