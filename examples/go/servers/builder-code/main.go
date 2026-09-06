package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/buildercode"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	ginmw "github.com/x402-foundation/x402/go/v2/http/gin"
	evm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/server"
)

const DefaultPort = "4021"

/**
 * Builder Code Example Server
 *
 * Gin server demonstrating ERC-8021 builder-code attribution on paid endpoints
 * via buildercode.DeclareBuilderCodeExtension.
 */

func main() {
	godotenv.Load()

	evmAddress := os.Getenv("EVM_ADDRESS")
	if evmAddress == "" {
		fmt.Println("❌ EVM_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("❌ FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	appBuilderCode := os.Getenv("APP_BUILDER_CODE")
	if appBuilderCode == "" {
		fmt.Println("❌ APP_BUILDER_CODE environment variable is required")
		os.Exit(1)
	}

	evmNetwork := x402.Network("eip155:84532")

	gin.SetMode(gin.ReleaseMode)
	r := gin.New()
	r.Use(gin.Recovery())

	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitatorClient),
	).Register(evmNetwork, evm.NewExactEvmScheme())

	builderCodeExt := buildercode.DeclareBuilderCodeExtension(appBuilderCode)
	extensions := make(map[string]interface{})
	for k, v := range builderCodeExt {
		extensions[k] = v
	}

	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					Price:   "$0.001",
					Network: evmNetwork,
					PayTo:   evmAddress,
				},
			},
			Description: "Weather data",
			MimeType:    "application/json",
			Extensions:  extensions,
		},
	}

	r.Use(ginmw.PaymentMiddleware(routes, server,
		ginmw.WithTimeout(30*time.Second),
	))

	r.GET("/weather", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{
			"report": gin.H{
				"weather":     "sunny",
				"temperature": 70,
			},
		})
	})

	fmt.Printf("Server listening at http://localhost:%s\n", DefaultPort)

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
