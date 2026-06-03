package main

import (
	"fmt"
	"math/big"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402gin "github.com/x402-foundation/x402/go/pkg/gin"
	"github.com/x402-foundation/x402/go/pkg/types"
)

var shutdownRequested bool

func main() {
	// Load .env file if it exists
	if err := godotenv.Load(); err != nil {
		fmt.Println("Warning: .env file not found. Using environment variables.")
	}

	// Get configuration from environment
	network := os.Getenv("EVM_NETWORK")
	if network == "" {
		network = "base-sepolia"
	}
	address := os.Getenv("EVM_PAYEE_ADDRESS")
	port := os.Getenv("PORT")
	if port == "" {
		port = "4021"
	}
	facilitatorURL := os.Getenv("FACILITATOR_URL")

	if address == "" {
		fmt.Println("Error: Missing required environment variable EVM_PAYEE_ADDRESS")
		os.Exit(1)
	}

	// Create facilitator config if URL is provided
	var facilitatorConfig *types.FacilitatorConfig
	if facilitatorURL != "" {
		facilitatorConfig = &types.FacilitatorConfig{
			URL: facilitatorURL,
		}
		fmt.Printf("Using remote facilitator at: %s\n", facilitatorURL)
	} else {
		fmt.Println("Using default facilitator")
	}

	// Set Gin to release mode to reduce logs
	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	// Protected endpoint that requires payment
	r.GET("/protected",
		x402gin.PaymentMiddleware(
			big.NewFloat(0.001), // $0.001 USD
			address,
			x402gin.WithFacilitatorConfig(facilitatorConfig),
			x402gin.WithDescription("Protected endpoint requiring payment"),
			x402gin.WithResource("http://localhost:"+port+"/protected"),
			x402gin.WithTestnet(network == "base-sepolia"),
		),
		func(c *gin.Context) {
			if shutdownRequested {
				c.JSON(http.StatusServiceUnavailable, gin.H{
					"error": "Server shutting down",
				})
				return
			}

			c.JSON(http.StatusOK, gin.H{
				"message":   "Access granted to protected resource",
				"timestamp": "2024-01-01T00:00:00Z",
				"data": gin.H{
					"resource":     "premium_content",
					"access_level": "paid",
				},
			})
		},
	)

	// Health check endpoint
	r.GET("/health", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"status":    "healthy",
			"timestamp": "2024-01-01T00:00:00Z",
			"server":    "gin",
		})
	})

	// Graceful shutdown endpoint
	r.POST("/close", func(c *gin.Context) {
		shutdownRequested = true

		c.JSON(http.StatusOK, gin.H{
			"message":   "Server shutting down gracefully",
			"timestamp": "2024-01-01T00:00:00Z",
		})

		// Schedule server shutdown after response
		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

	// Set up graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		fmt.Println("Received shutdown signal, exiting...")
		os.Exit(0)
	}()

	fmt.Printf("Starting Gin server on port %s\n", port)
	fmt.Printf("Server address: %s\n", address)
	fmt.Printf("Network: %s\n", network)
	if facilitatorURL != "" {
		fmt.Printf("Using facilitator: %s\n", facilitatorURL)
	} else {
		fmt.Printf("Using default facilitator\n")
	}
	fmt.Printf("Server listening on port %s\n", port)

	server := &http.Server{
		Addr:    ":" + port,
		Handler: r,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
