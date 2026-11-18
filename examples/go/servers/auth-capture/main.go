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
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcaptureserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

const (
	defaultPort = "4021"
	network     = x402.Network("eip155:84532")
	price       = "$0.01"
)

// Auth-capture resource server demo: after the handler runs, the facilitator captures
// (on success) or voids (on failure). The receiver authorizer's signature comes either from
// this server (EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY set) or, when that key is omitted, from
// the facilitator, which advertises its own receiverAuthorizer in GET /supported.
//
// Run `go run . custom-escrow` for the collect-only custom-operator flow.
func main() {
	_ = godotenv.Load()

	if len(os.Args) > 1 && os.Args[1] == "custom-escrow" {
		runCustomEscrow()
		return
	}

	evmAddress := requireEnv("EVM_PAYEE_ADDRESS")
	facilitatorURL := requireEnv("FACILITATOR_URL")

	// Optional: omit to delegate capture/void signing to the facilitator.
	config := &authcaptureserver.Config{
		// CaptureAuthorizer/FeeRecipient/MinFeeBps/MaxFeeBps are left empty here so
		// this server falls back to whatever the facilitator advertises; set them
		// explicitly to pin your own escrow terms instead.
	}
	var receiverAuthorizer evm.ClientEvmSigner
	if receiverAuthKey := os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"); receiverAuthKey != "" {
		signer, err := evmsigners.NewClientSignerFromPrivateKey(receiverAuthKey)
		if err != nil {
			fmt.Printf("Invalid EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
			os.Exit(1)
		}
		receiverAuthorizer = signer
		config.ReceiverAuthorizerSigner = signer
	}

	scheme := authcaptureserver.NewAuthCaptureEvmScheme(config)

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

	port := envOr("PORT", defaultPort)
	fmt.Printf("Auth-capture server listening on http://localhost:%s\n", port)
	fmt.Printf("  GET /weather\n")
	if receiverAuthorizer != nil {
		fmt.Printf("  Receiver authorizer (self): %s\n", receiverAuthorizer.Address())
	} else {
		fmt.Println("  Receiver authorizer: delegated to facilitator (from /supported extra.receiverAuthorizer)")
	}

	if err := http.ListenAndServe(":"+port, handler); err != nil {
		fmt.Printf("Server error: %v\n", err)
		os.Exit(1)
	}
}
