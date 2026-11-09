package main

import (
	"fmt"
	"net/http"
	"os"
	"time"

	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	ginmw "github.com/x402-foundation/x402/go/v2/http/gin"
	evm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/server"
	svm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/server"
)

const DefaultPort = "4021"

func main() {
	godotenv.Load()

	evmAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	svmAddress := os.Getenv("SVM_PAYEE_ADDRESS")
	if evmAddress == "" && svmAddress == "" {
		fmt.Println("One of EVM_PAYEE_ADDRESS or SVM_PAYEE_ADDRESS is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	evmNetwork := x402.Network("eip155:84532")
	svmNetwork := x402.Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")

	fmt.Printf("Starting Gin x402 upfront server...\n")
	fmt.Printf("  Facilitator: %s\n", facilitatorURL)

	var accepts x402http.PaymentOptions
	var schemes []ginmw.SchemeConfig

	if evmAddress != "" {
		fmt.Printf("  EVM Payee address: %s (%s)\n", evmAddress, evmNetwork)
		accepts = append(accepts, x402http.PaymentOption{
			Scheme:  "exact",
			Price:   "$0.001",
			Network: evmNetwork,
			PayTo:   evmAddress,
			Extra: map[string]interface{}{
				"paymentFlow": "upfront",
			},
		})
		schemes = append(schemes, ginmw.SchemeConfig{
			Network: evmNetwork,
			Server:  evm.NewExactEvmScheme(),
		})
	}

	if svmAddress != "" {
		fmt.Printf("  SVM Payee address: %s (%s)\n", svmAddress, svmNetwork)
		accepts = append(accepts, x402http.PaymentOption{
			Scheme:  "exact",
			Price:   "$0.001",
			Network: svmNetwork,
			PayTo:   svmAddress,
			Extra: map[string]interface{}{
				"paymentFlow": "upfront",
			},
		})
		schemes = append(schemes, ginmw.SchemeConfig{
			Network: svmNetwork,
			Server:  svm.NewExactSvmScheme(),
		})
	}

	r := ginfw.Default()

	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitatorClient),
	).
		OnAfterSettle(func(ctx x402.SettleResultContext) error {
			fmt.Printf("[upfront] settled (%s) tx=%s\n", ctx.Phase, ctx.Result.Transaction)
			return nil
		})
	for _, scheme := range schemes {
		resourceServer.Register(scheme.Network, scheme.Server)
	}

	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts:     accepts,
			Description: "Weather data",
			MimeType:    "application/json",
		},
	}

	r.Use(ginmw.PaymentMiddleware(routes, resourceServer, ginmw.WithTimeout(30*time.Second)))

	r.GET("/weather", func(c *ginfw.Context) {
		fmt.Println("[upfront] handler running (settlement already completed)")
		c.JSON(http.StatusOK, ginfw.H{
			"report": ginfw.H{
				"weather":     "sunny",
				"temperature": 70,
			},
		})
	})

	r.GET("/health", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{
			"status":  "ok",
			"version": "2.0.0",
		})
	})

	fmt.Printf("  Server listening on http://localhost:%s\n\n", DefaultPort)
	fmt.Println("  GET /weather  - exact scheme with upfront payment flow")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
