package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	echomw "github.com/coinbase/x402/go/http/echo"
	evm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	svm "github.com/coinbase/x402/go/mechanisms/svm/exact/server"
	"github.com/joho/godotenv"
	"github.com/labstack/echo/v4"
)

const (
	DefaultPort = "4021"
)

func main() {
	godotenv.Load()

	evmAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	if evmAddress == "" {
		fmt.Println("❌ EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	svmAddress := os.Getenv("SVM_PAYEE_ADDRESS")
	if svmAddress == "" {
		fmt.Println("❌ SVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("❌ FACILITATOR_URL environment variable is required")
		fmt.Println("   Example: https://x402.org/facilitator")
		os.Exit(1)
	}

	// Network configuration - Base Sepolia testnet
	evmNetwork := x402.Network("eip155:84532")
	svmNetwork := x402.Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")

	fmt.Printf("🚀 Starting Echo x402 server...\n")
	fmt.Printf("   EVM Payee address: %s\n", evmAddress)
	fmt.Printf("   SVM Payee address: %s\n", svmAddress)
	fmt.Printf("   EVM Network: %s\n", evmNetwork)
	fmt.Printf("   SVM Network: %s\n", svmNetwork)
	fmt.Printf("   Facilitator: %s\n", facilitatorURL)

	// Create Echo instance
	e := echo.New()
	e.HideBanner = true

	// Create HTTP facilitator client
	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	/**
	 * Configure x402 payment middleware
	 *
	 * This middleware protects specific routes with payment requirements.
	 * When a client accesses a protected route without payment, they receive
	 * a 402 Payment Required response with payment details.
	 */
	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					Price:   "$0.001",
					Network: "eip155:84532",
					PayTo:   evmAddress,
				},
				{
					Scheme:  "exact",
					Price:   "$0.001",
					Network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
					PayTo:   svmAddress,
				},
			},
			Description: "Get weather data for a city",
			MimeType:    "application/json",
		},
	}

	// Apply x402 payment middleware
	e.Use(echomw.X402Payment(echomw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []echomw.SchemeConfig{
			{Network: evmNetwork, Server: evm.NewExactEvmScheme()},
			{Network: svmNetwork, Server: svm.NewExactSvmScheme()},
		},
		Timeout: 30 * time.Second,
	}))

	/**
	 * Protected endpoint - requires $0.001 USDC payment
	 *
	 * Clients must provide a valid x402 payment to access this endpoint.
	 * The payment is verified and settled before the endpoint handler runs.
	 */
	e.GET("/weather", func(c echo.Context) error {
		city := c.QueryParam("city")
		if city == "" {
			city = "San Francisco"
		}

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

		return c.JSON(http.StatusOK, map[string]interface{}{
			"city":        city,
			"weather":     data["weather"],
			"temperature": data["temperature"],
			"timestamp":   time.Now().Format(time.RFC3339),
		})
	})

	/**
	 * Health check endpoint - no payment required
	 *
	 * This endpoint is not protected by x402 middleware.
	 */
	e.GET("/health", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{
			"status":  "ok",
			"version": "2.0.0",
		})
	})

	fmt.Printf("   Server listening on http://localhost:%s\n\n", DefaultPort)

	if err := e.Start(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
