package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	x402http "github.com/x402-foundation/x402/go/v2/http"
	nethttpmw "github.com/x402-foundation/x402/go/v2/http/nethttp"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	authcaptureserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server"
)

func runCustomEscrow() {
	evmAddress := requireEnv("EVM_PAYEE_ADDRESS")
	facilitatorURL := requireEnv("FACILITATOR_URL")

	customOperator := os.Getenv("CUSTOM_OPERATOR_ADDRESS")
	if !evm.IsValidAddress(customOperator) {
		fmt.Println(
			"Missing or invalid CUSTOM_OPERATOR_ADDRESS " +
				"(deploy a custom operator and allowlist it on the facilitator)",
		)
		os.Exit(1)
	}
	customOperator = evm.NormalizeAddress(customOperator)

	var minFeeBps, maxFeeBps uint16
	captureDeadlineSeconds := uint64(3600)
	refundDeadlineSeconds := uint64(7200)
	routeExtra := authcaptureserver.AuthCaptureRouteExtra{
		FeeRecipient:           authcapture.ZeroAddress,
		MinFeeBps:              &minFeeBps,
		MaxFeeBps:              &maxFeeBps,
		CaptureDeadlineSeconds: &captureDeadlineSeconds,
		RefundDeadlineSeconds:  &refundDeadlineSeconds,
		CaptureAuthorizer:      customOperator,
		ReceiverAuthorizer:     authcapture.ZeroAddress,
		OperatorType:           authcapture.OperatorTypeCustom,
		PaymentFlow:            authcapture.PaymentFlowEscrow,
		CaptureMode:            authcapture.CaptureModeDeferred,
	}

	scheme := authcaptureserver.NewAuthCaptureEvmScheme(&authcaptureserver.Config{
		CollectOnlyRoutes: true,
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
					PayTo:             evm.NormalizeAddress(evmAddress),
					MaxTimeoutSeconds: 300,
					Extra:             routeExtra.Map(),
				},
			},
			Description: "Weather data",
			MimeType:    "application/json",
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /weather", func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"report": map[string]any{
				"weather":     "sunny",
				"temperature": 70,
				"flow":        "custom-escrow",
			},
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
	fmt.Printf("Auth-capture server (custom-escrow) listening on http://localhost:%s\n", port)
	fmt.Println("  GET /weather")
	fmt.Printf("  Custom operator: %s\n", customOperator)
	fmt.Println("  Collect-only: capture/void/refund run out of band on the operator contract.")

	if err := http.ListenAndServe(":"+port, handler); err != nil {
		fmt.Printf("Server error: %v\n", err)
		os.Exit(1)
	}
}

func requireEnv(key string) string {
	v := os.Getenv(key)
	if v == "" {
		fmt.Printf("%s environment variable is required\n", key)
		os.Exit(1)
	}
	return v
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}
