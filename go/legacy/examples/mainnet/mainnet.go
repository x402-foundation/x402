package main

import (
	"fmt"
	"math/big"
	"os"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"github.com/x402-foundation/x402/go/pkg/coinbasefacilitator"
	x402gin "github.com/x402-foundation/x402/go/pkg/gin"
)

func main() {
	// Load .env file if it exists
	if err := godotenv.Load(); err != nil {
		fmt.Println("Warning: .env file not found. Using environment variables.")
	}

	// Check for required environment variables
	apiKeyID := os.Getenv("CDP_API_KEY_ID")
	apiKeySecret := os.Getenv("CDP_API_KEY_SECRET")
	payTo := os.Getenv("ADDRESS")

	if apiKeyID == "" || apiKeySecret == "" || payTo == "" {
		fmt.Println("Error: CDP_API_KEY_ID, CDP_API_KEY_SECRET, and ADDRESS environment variables must be set")
		fmt.Println("Please set these variables in your .env file or environment")
		fmt.Println("Example .env file:")
		fmt.Println("CDP_API_KEY_ID=your_key_id")
		fmt.Println("CDP_API_KEY_SECRET=your_key_secret")
		fmt.Println("ADDRESS=your_wallet_address")
		os.Exit(1)
	}

	// Create facilitator config with CDP auth
	facilitatorConfig := coinbasefacilitator.CreateFacilitatorConfig(apiKeyID, apiKeySecret)

	r := gin.Default()

	// Protected endpoint that costs $0.01 USDC
	r.GET(
		"/premium-joke",
		x402gin.PaymentMiddleware(
			big.NewFloat(0.01), // $0.01 USD
			payTo,              // Your wallet address
			x402gin.WithFacilitatorConfig(facilitatorConfig),
			x402gin.WithDescription("A premium programming joke"),
			x402gin.WithResource("https://api.example.com/premium-joke"),
			x402gin.WithTestnet(false), // Use mainnet!
		),
		func(c *gin.Context) {
			c.JSON(200, gin.H{
				"joke": "Why do Java developers wear glasses? Because they don't C#!",
				"type": "premium",
			})
		},
	)

	// Free endpoint for comparison
	r.GET("/free-joke", func(c *gin.Context) {
		c.JSON(200, gin.H{
			"joke": "What's a programmer's favorite place? The Foo Bar!",
			"type": "free",
		})
	})

	fmt.Println("Starting mainnet example server on :4021")
	fmt.Println("- Free joke available at: http://localhost:4021/free-joke")
	fmt.Println("- Premium joke (costs $0.01) available at: http://localhost:4021/premium-joke")
	fmt.Println("Make sure CDP_API_KEY_ID and CDP_API_KEY_SECRET are set in your environment")

	if err := r.Run(":4021"); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
