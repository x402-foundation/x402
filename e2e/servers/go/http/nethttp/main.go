package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	e2eserver "github.com/x402-foundation/x402/e2e/servers/go"
	x402 "github.com/x402-foundation/x402/go/v2"
	nethttpmw "github.com/x402-foundation/x402/go/v2/http/nethttp"
)

var shutdownRequested bool

// net/http E2E Test Server with x402 v2 Payment Middleware.
//
// Paid routes come from the mechanisms catalog — see e2eserver.CatalogRoutes.

func main() {
	cfg := e2eserver.LoadConfig()
	routes := e2eserver.BuildRoutes()
	facilitatorClient := e2eserver.NewFacilitatorClient(cfg)

	schemes := make([]nethttpmw.SchemeConfig, 0)
	for _, binding := range e2eserver.SchemeBindings(cfg) {
		schemes = append(schemes, nethttpmw.SchemeConfig{Network: binding.Network, Server: binding.Server})
	}

	mux := http.NewServeMux()

	// Protected endpoints — clients must present a valid payment to access these.
	for _, route := range e2eserver.CatalogRoutes() {
		paidRoute := route
		mux.HandleFunc("GET "+paidRoute.Path, func(w http.ResponseWriter, r *http.Request) {
			if shutdownRequested {
				writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
					"error": "Server shutting down",
				})
				return
			}
			if paidRoute.SettlementOverride != nil {
				nethttpmw.SetSettlementOverrides(w, &x402.SettlementOverrides{
					Amount: paidRoute.SettlementOverride.Amount,
				})
			}
			writeJSON(w, http.StatusOK, e2eserver.RouteBody())
		})
	}

	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, e2eserver.HealthBody())
	})

	mux.HandleFunc("POST /close", func(w http.ResponseWriter, r *http.Request) {
		shutdownRequested = true

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message": "Server shutting down gracefully",
		})
		fmt.Println("Received shutdown request")

		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

	paymentHandler := nethttpmw.X402Payment(nethttpmw.Config{
		Routes:                 routes,
		Facilitator:            facilitatorClient,
		Schemes:                schemes,
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			fmt.Printf("❌ [E2E SERVER ERROR] Payment error occurred\n")
			fmt.Printf("   Path: %s\n", r.URL.Path)
			fmt.Printf("   Method: %s\n", r.Method)
			fmt.Printf("   Error: %v\n", err)
			fmt.Printf("   Headers: %v\n", r.Header)

			writeJSON(w, http.StatusPaymentRequired, map[string]interface{}{
				"error": err.Error(),
			})
		},
		SettlementHandler: func(w http.ResponseWriter, r *http.Request, settleResp *x402.SettleResponse) {
			fmt.Printf("✅ [E2E SERVER SUCCESS] Payment settled\n")
			fmt.Printf("   Path: %s\n", r.URL.Path)
			fmt.Printf("   Transaction: %s\n", settleResp.Transaction)
			fmt.Printf("   Network: %s\n", settleResp.Network)
			fmt.Printf("   Payer: %s\n", settleResp.Payer)
		},
	})(mux)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if err := e2eserver.UnconfiguredErrorForPath(r.URL.Path); err != nil {
			writeJSON(w, http.StatusNotImplemented, err)
			return
		}
		paymentHandler.ServeHTTP(w, r)
	})

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		fmt.Println("Received shutdown signal, exiting...")
		os.Exit(0)
	}()

	fmt.Println(e2eserver.FormatStartupBanner(
		"x402 net/http E2E Test Server",
		"http://localhost:"+cfg.Port,
	))

	server := &http.Server{
		Addr:    ":" + cfg.Port,
		Handler: handler,
	}

	if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("Error starting server: %v\n", err)
		os.Exit(1)
	}
}

// writeJSON is a helper to write JSON responses.
func writeJSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}
