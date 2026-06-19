package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/extensions/signinwithx"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	nethttp "github.com/x402-foundation/x402/go/v2/http/nethttp"
	exactevmserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/exact/server"
)

const evmNetwork = "eip155:84532"

func main() {
	_ = godotenv.Load()

	evmAddress := os.Getenv("EVM_ADDRESS")
	if evmAddress == "" {
		log.Fatal("EVM_ADDRESS is required")
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		log.Fatal("FACILITATOR_URL is required")
	}

	port := os.Getenv("PORT")
	if port == "" {
		port = "4021"
	}

	storage := signinwithx.NewInMemoryStorage()
	extension := signinwithx.MustCreateResourceServerExtension(signinwithx.ServerOptions{
		Storage: storage,
		OnEvent: func(event signinwithx.HookEvent) {
			log.Printf("siwx event=%s resource=%s address=%s error=%s", event.Type, event.Resource, event.Address, event.Error)
		},
	})

	routes := x402http.RoutesConfig{
		"GET /weather": protectedRoute("/weather", evmAddress),
		"GET /joke":    protectedRoute("/joke", evmAddress),
		"GET /profile": {
			Accepts:     x402http.PaymentOptions{},
			Description: "Auth-only: wallet signature required",
			Extensions: map[string]interface{}{
				signinwithx.ExtensionKey: signinwithx.DeclareExtension(signinwithx.DeclareOptions{
					Statement:         "Sign in to view your profile",
					Networks:          []string{evmNetwork},
					ExpirationSeconds: 300,
				})[signinwithx.ExtensionKey],
			},
		},
	}

	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})
	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(facilitatorClient),
		x402.WithSchemeServer(evmNetwork, exactevmserver.NewExactEvmScheme()),
	)
	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer).
		RegisterExtension(extension)

	mux := http.NewServeMux()
	mux.HandleFunc("GET /weather", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{"weather": "sunny", "temperature": 72})
	})
	mux.HandleFunc("GET /joke", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"joke": "Why do programmers prefer dark mode? Because light attracts bugs.",
		})
	})
	mux.HandleFunc("GET /profile", func(w http.ResponseWriter, r *http.Request) {
		payload, err := signinwithx.ParseHeader(r.Header.Get(signinwithx.HeaderName))
		if err != nil {
			writeJSON(w, http.StatusOK, map[string]interface{}{
				"authenticated": true,
				"profile": map[string]string{
					"name": "SIWX demo user",
				},
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"address": payload.Address,
			"data":    "Your profile data",
		})
	})
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})

	handler := nethttp.PaymentMiddlewareFromHTTPServer(httpServer)(mux)

	log.Printf("sign-in-with-x server listening on http://localhost:%s", port)
	log.Printf("routes: GET /weather, GET /joke, GET /profile (auth-only)")
	log.Fatal(http.ListenAndServe(":"+port, handler))
}

func protectedRoute(path string, payTo string) x402http.RouteConfig {
	return x402http.RouteConfig{
		Accepts: x402http.PaymentOptions{
			{
				Scheme:  "exact",
				Price:   "$0.001",
				Network: evmNetwork,
				PayTo:   payTo,
			},
		},
		Description: fmt.Sprintf("Protected resource: %s", path),
		MimeType:    "application/json",
		Extensions: map[string]interface{}{
			signinwithx.ExtensionKey: signinwithx.DeclareExtension(signinwithx.DeclareOptions{
				Networks: []string{evmNetwork},
			})[signinwithx.ExtensionKey],
		},
	}
}

func writeJSON(w http.ResponseWriter, status int, body interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(body)
}
