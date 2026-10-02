package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	nethttpmw "github.com/x402-foundation/x402/go/v2/http/nethttp"
	authcaptureserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

const (
	defaultPort = "4021"
	network     = x402.Network("eip155:84532")
	price       = "$0.01"
)

// Auth-capture resource server demo: after the handler runs, its receiver-authorizer
// signature lets the facilitator capture (on success) or void (on failure).
func main() {
	_ = godotenv.Load()

	evmAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	if evmAddress == "" {
		fmt.Println("EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	receiverAuthKey := os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
	if receiverAuthKey == "" {
		fmt.Println("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}
	receiverAuthorizer, err := evmsigners.NewClientSignerFromPrivateKey(receiverAuthKey)
	if err != nil {
		fmt.Printf("Invalid EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
		os.Exit(1)
	}

	scheme := authcaptureserver.NewAuthCaptureEvmScheme(&authcaptureserver.Config{
		ReceiverAuthorizerSigner: receiverAuthorizer,
		// CaptureAuthorizer/FeeRecipient/MinFeeBps/MaxFeeBps are left empty here so
		// this server falls back to whatever the facilitator advertises; set them
		// explicitly to pin your own escrow terms instead.
	})

	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:            "auth-capture",
					Price:             price,
					Network:           network,
					PayTo:             evmAddress,
					MaxTimeoutSeconds: 300,
				},
			},
			Description: "Weather data, settled via escrow authorize/capture",
			MimeType:    "application/json",
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /weather", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"weather":     "sunny",
			"temperature": 70,
		})
	})

	handler := nethttpmw.X402Payment(nethttpmw.Config{
		Routes:      routes,
		Facilitator: facilitator,
		Schemes: []nethttpmw.SchemeConfig{
			{Network: network, Server: scheme},
		},
		Timeout: 30 * time.Second,
	})(mux)

	fmt.Printf("Auth-capture server listening on http://localhost:%s\n", defaultPort)
	fmt.Printf("  GET /weather\n")
	fmt.Printf("  Receiver authorizer: %s\n", receiverAuthorizer.Address())

	if err := http.ListenAndServe(":"+defaultPort, handler); err != nil {
		fmt.Printf("Server error: %v\n", err)
		os.Exit(1)
	}
}
