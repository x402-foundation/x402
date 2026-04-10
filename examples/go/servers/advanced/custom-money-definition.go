package main

import (
	"fmt"
	"math"
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
 * Custom Money Definition Example
 *
 * This example demonstrates how to register custom money parsers to use
 * alternative tokens or custom logic for converting prices to blockchain assets.
 * This is useful when you want to accept payments in tokens other than the default USDC.
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
	 * Create EVM Scheme with Custom Money Parser
	 *
	 * This demonstrates registering a custom money parser that handles
	 * specific network or amount conditions differently.
	 *
	 * For example, on Gnosis Chain (xDai) network, we could use Wrapped XDAI
	 * instead of USDC (this is for demonstration - WXDAI isn't EIP-3009 compliant).
	 */
	evmScheme := evm.NewExactEvmScheme().RegisterMoneyParser(func(amount float64, network x402.Network) (*x402.AssetAmount, error) {
		// Custom logic for Gnosis Chain (eip155:100)
		if string(network) == "eip155:100" {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", amount*1e18),             // Wrapped XDAI has 18 decimals
				Asset:  "0xe91d153e0b41518a2ce8dd3d7944fa863463a97d", // WXDAI address on Gnosis
				Extra: map[string]interface{}{
					"token":   "Wrapped XDAI",
					"network": "gnosis",
				},
			}, nil
		}

		// For large amounts on any network, use DAI instead of USDC
		if amount > 100 {
			return &x402.AssetAmount{
				Amount: fmt.Sprintf("%.0f", math.Round(amount*1e18)), // DAI has 18 decimals
				Asset:  "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", // DAI on Base Sepolia
				Extra: map[string]interface{}{
					"token": "DAI",
					"tier":  "large",
				},
			}, nil
		}

		// Return nil to use the default USDC parser for other cases
		return nil, nil
	})

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
			Description: "Weather data",
			MimeType:    "application/json",
		},
	}

	r.Use(ginmw.X402Payment(ginmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []ginmw.SchemeConfig{
			{Network: evmNetwork, Server: evmScheme}, // Use custom scheme
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

	fmt.Printf("🚀 Custom Money Definition example running on http://localhost:%s\n", DefaultPort)
	fmt.Printf("   Using custom money parsers for different networks and amounts\n")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
