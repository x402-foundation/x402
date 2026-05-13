package main

import (
	"fmt"
	"net/http"
	"os"

	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	ginmw "github.com/x402-foundation/x402/go/http/gin"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm/exact/server"
)

const DefaultPort = "4021"

/**
 * Lifecycle Hooks Example
 *
 * This example demonstrates how to register hooks at different stages
 * of the payment verification and settlement lifecycle. Hooks are useful
 * for logging, custom validation, error recovery, and side effects.
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

	// Create facilitator client
	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	// Create EVM scheme server
	evmScheme := evm.NewExactEvmScheme()

	// Create x402 resource server with hooks
	server := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitatorClient),
	).
		Register(evmNetwork, evmScheme).
		// Hook 1: Before Verify - Called before payment verification
		// Can abort verification by returning &BeforeHookResult{Abort: true, Reason: "..."}
		OnBeforeVerify(func(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
			fmt.Printf("🔵 Before verify hook - Scheme: %s, Network: %s\n",
				ctx.Requirements.GetScheme(), ctx.Requirements.GetNetwork())
			// Example: Abort verification
			// return &x402.BeforeHookResult{Abort: true, Reason: "Custom validation failed"}, nil
			return nil, nil
		}).
		// Hook 2: After Verify - Called after successful payment verification
		OnAfterVerify(func(ctx x402.VerifyResultContext) error {
			fmt.Printf("🟢 After verify hook - IsValid: %v\n", ctx.Result.IsValid)
			return nil
		}).
		// Hook 3: Verify Failure - Called when payment verification fails
		// Can recover from failure by returning &VerifyFailureHookResult{Recovered: true, Result: ...}
		OnVerifyFailure(func(ctx x402.VerifyFailureContext) (*x402.VerifyFailureHookResult, error) {
			fmt.Printf("🔴 Verify failure hook - Error: %v\n", ctx.Error)
			// Example: Recover from failure
			// return &x402.VerifyFailureHookResult{
			// 	Recovered: true,
			// 	Result:    &x402.VerifyResponse{IsValid: true, InvalidReason: "Recovered from failure"},
			// }, nil
			return nil, nil
		}).
		// Hook 4: Before Settle - Called before payment settlement
		// Can abort settlement by returning &BeforeHookResult{Abort: true, Reason: "..."}
		OnBeforeSettle(func(ctx x402.SettleContext) (*x402.BeforeHookResult, error) {
			fmt.Printf("🔵 Before settle hook - Scheme: %s, Network: %s\n",
				ctx.Requirements.GetScheme(), ctx.Requirements.GetNetwork())
			// Example: Abort settlement
			// return &x402.BeforeHookResult{Abort: true, Reason: "Settlement temporarily disabled"}, nil
			return nil, nil
		}).
		// Hook 5: After Settle - Called after successful payment settlement
		OnAfterSettle(func(ctx x402.SettleResultContext) error {
			fmt.Printf("🟢 After settle hook - Success: %v, Transaction: %s\n",
				ctx.Result.Success, ctx.Result.Transaction)
			return nil
		}).
		// Hook 6: Settle Failure - Called when payment settlement fails
		// Can recover from failure by returning &SettleFailureHookResult{Recovered: true, Result: ...}
		OnSettleFailure(func(ctx x402.SettleFailureContext) (*x402.SettleFailureHookResult, error) {
			fmt.Printf("🔴 Settle failure hook - Error: %v\n", ctx.Error)
			// Example: Recover from failure
			// return &x402.SettleFailureHookResult{
			// 	Recovered: true,
			// 	Result:    &x402.SettleResponse{Success: true, Transaction: "0x123..."},
			// }, nil
			return nil, nil
		})

	// Define routes
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

	// Create Gin router with x402 payment middleware
	r := ginfw.Default()
	r.Use(ginmw.PaymentMiddleware(routes, server))

	r.GET("/weather", func(c *ginfw.Context) {
		c.JSON(http.StatusOK, ginfw.H{
			"report": ginfw.H{
				"weather":     "sunny",
				"temperature": 70,
			},
		})
	})

	fmt.Printf("🚀 Lifecycle Hooks example running on http://localhost:%s\n", DefaultPort)
	fmt.Printf("   Watch the console for hook execution logs\n")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
