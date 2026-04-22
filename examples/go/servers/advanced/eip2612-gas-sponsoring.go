package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	x402http "github.com/x402-foundation/x402/go/http"
	ginmw "github.com/x402-foundation/x402/go/http/gin"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

const eip2612DefaultPort = "4021"

// This example demonstrates how to set up a server that supports the
// Permit2 payment flow with EIP-2612 gasless approval. When a client
// doesn't have an existing Permit2 approval, the facilitator will use
// the client's EIP-2612 permit signature to approve Permit2 on-chain
// as part of the settlement transaction.
func eip2612GasSponsoringExample() {
	_ = godotenv.Load()

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("FACILITATOR_URL is required")
		os.Exit(1)
	}

	evmPayeeAddress := os.Getenv("EVM_ADDRESS")
	if evmPayeeAddress == "" {
		fmt.Println("EVM_ADDRESS is required")
		os.Exit(1)
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = eip2612DefaultPort
	}

	evmNetwork := x402.Network("eip155:84532")
	facilitatorClient := x402http.NewHTTPFacilitatorClient(facilitatorURL)

	// Build EIP-2612 gas sponsoring extension declaration
	eip2612Ext := eip2612gassponsor.DeclareEip2612GasSponsoringExtension()
	extensions := make(map[string]interface{})
	for k, v := range eip2612Ext {
		extensions[k] = v
	}

	// Define routes with Permit2 + EIP-2612 gas sponsoring
	routes := x402http.RouteConfig{
		// This endpoint uses Permit2 and advertises EIP-2612 gas sponsoring
		"GET /premium-data": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   evmPayeeAddress,
					Network: evmNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
						},
					},
				},
			},
			Extensions: extensions,
		},
	}

	r := ginfw.Default()

	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []ginmw.SchemeConfig{
			{Network: evmNetwork, Server: evm.NewExactEvmScheme()},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}))

	r.GET("/premium-data", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{
			"data":      "premium market data",
			"timestamp": time.Now().Format(time.RFC3339),
		})
	})

	fmt.Printf("Server with EIP-2612 Gas Sponsoring listening at http://localhost:%s\n", port)
	if err := r.Run(":" + port); err != nil {
		fmt.Printf("Failed to start server: %v\n", err)
		os.Exit(1)
	}
}
