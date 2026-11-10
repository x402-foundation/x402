package main

import (
	"context"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"strings"
	"time"

	ginfw "github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/eip2612gassponsor"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	ginmw "github.com/x402-foundation/x402/go/v2/http/gin"
	uptoevm "github.com/x402-foundation/x402/go/v2/mechanisms/evm/upto/server"
	uptosvm "github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto/server"
	svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
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

	fmt.Printf("Starting Gin x402 upto server...\n")
	fmt.Printf("  Facilitator: %s\n", facilitatorURL)

	// The "upto" scheme authorizes up to a maximum amount but settles only what
	// the handler asks for, which is what makes usage-based billing possible.
	maxPrice := "$0.10"

	var accepts x402http.PaymentOptions

	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	resourceServer := x402.Newx402ResourceServer(x402.WithFacilitatorClient(facilitatorClient))

	if evmAddress != "" {
		fmt.Printf("  EVM Payee address: %s (%s)\n", evmAddress, evmNetwork)
		accepts = append(accepts, x402http.PaymentOption{
			Scheme:  "upto",
			Price:   maxPrice,
			Network: evmNetwork,
			PayTo:   evmAddress,
		})
		resourceServer = resourceServer.Register(evmNetwork, uptoevm.NewUptoEvmScheme())
	}

	if svmAddress != "" {
		fmt.Printf("  SVM Payee address: %s (%s)\n", svmAddress, svmNetwork)
		svmConfig := &uptosvm.Config{
			RPCURL: os.Getenv("SVM_RPC_URL"),
		}
		authorizerKey := strings.TrimSpace(os.Getenv("SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"))
		if authorizerKey != "" {
			authorizer, err := svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(authorizerKey)
			if err != nil {
				fmt.Printf("Failed to load SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
				os.Exit(1)
			}
			fmt.Printf("  SVM receiver authorizer: %s\n", authorizer.Address())
			svmConfig.ReceiverAuthorizerSigner = authorizer
		} else {
			fmt.Println("  SVM receiver authorizer: delegated to facilitator")
		}
		accepts = append(accepts, x402http.PaymentOption{
			Scheme:  "upto",
			Price:   maxPrice,
			Network: svmNetwork,
			PayTo:   svmAddress,
		})
		resourceServer = resourceServer.Register(svmNetwork, uptosvm.NewUptoSvmScheme(svmConfig))
	}

	initCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if err := resourceServer.Initialize(initCtx); err != nil {
		fmt.Printf("Failed to initialize x402 resource server: %v\n", err)
		os.Exit(1)
	}

	r := ginfw.Default()

	route := x402http.RouteConfig{
		Accepts:     accepts,
		Description: "AI text generation - billed by token usage",
		MimeType:    "application/json",
	}
	if evmAddress != "" {
		route.Extensions = eip2612gassponsor.DeclareEip2612GasSponsoringExtension()
	}

	r.Use(ginmw.PaymentMiddleware(
		x402http.RoutesConfig{"GET /api/generate": route},
		resourceServer,
		ginmw.WithSyncFacilitatorOnStart(false),
		ginmw.WithTimeout(30*time.Second),
	))

	r.GET("/api/generate", func(c *ginfw.Context) {
		// Simulate work that produces a variable cost.
		// In production this might be LLM token count, bytes served, compute time, etc.
		maxAmountAtomic := 100000 // 10 cents in 6-decimal USDC atomic units
		actualUsage := rand.Intn(maxAmountAtomic + 1)

		// Tell the middleware to settle only what was actually used.
		ginmw.SetSettlementOverrides(c, &x402.SettlementOverrides{
			Amount: fmt.Sprintf("%d", actualUsage),
		})

		c.JSON(http.StatusOK, ginfw.H{
			"result": "Here is your generated text...",
			"usage": ginfw.H{
				"authorizedMaxAtomic": fmt.Sprintf("%d", maxAmountAtomic),
				"actualChargedAtomic": fmt.Sprintf("%d", actualUsage),
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
	fmt.Println("  GET /api/generate  - usage-based billing via upto scheme")

	if err := r.Run(":" + DefaultPort); err != nil {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}
