package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	nethttpmw "github.com/x402-foundation/x402/go/http/nethttp"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	batchedserver "github.com/x402-foundation/x402/go/mechanisms/evm/batched/server"
)

const (
	defaultPort = "4021"
	network     = x402.Network("eip155:84532")
	maxPrice    = "$0.01"
)

func main() {
	_ = godotenv.Load()

	evmAddress := os.Getenv("EVM_ADDRESS")
	if !regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`).MatchString(evmAddress) {
		fmt.Println("Missing or invalid EVM_ADDRESS (checksummed 20-byte hex, 0x-prefixed)")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("Missing required FACILITATOR_URL environment variable")
		os.Exit(1)
	}

	withdrawDelay := batched.MinWithdrawDelay
	if v := os.Getenv("DEFERRED_WITHDRAW_DELAY_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			withdrawDelay = n
		}
	}

	receiverAuthKey := os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
	storageDir := os.Getenv("STORAGE_DIR")

	cfg := &batchedserver.BatchedEvmSchemeConfig{
		WithdrawDelay: withdrawDelay,
	}
	if receiverAuthKey != "" {
		signer, err := newReceiverAuthorizerSigner(receiverAuthKey)
		if err != nil {
			fmt.Printf("Invalid EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
			os.Exit(1)
		}
		cfg.ReceiverAuthorizerSigner = signer
	}
	if storageDir != "" {
		cfg.Storage = batchedserver.NewFileSessionStorage(batched.FileSessionStorageOptions{
			Directory: storageDir,
		})
	}

	scheme := batchedserver.NewBatchedEvmScheme(evmAddress, cfg)

	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	manager := scheme.CreateChannelManager(facilitator, network)
	manager.Start(batchedserver.AutoSettlementConfig{
		TickSecs:           5,
		ClaimIntervalSecs:  10,
		ClaimOnWithdrawal:  true,
		MaxClaimsPerBatch:  50,
		SettleIntervalSecs: 20,
		RefundOnIdleSecs:   30,
		OnClaim: func(r batchedserver.ClaimResult) {
			fmt.Printf("Claimed %d vouchers (tx: %s)\n", r.Vouchers, r.Transaction)
		},
		OnSettle: func(r batchedserver.SettleResult) {
			fmt.Printf("Settled to %s (tx: %s)\n", evmAddress, r.Transaction)
		},
		OnRefund: func(r batchedserver.RefundResult) {
			fmt.Printf("Refund for %d channel(s) (tx: %s)\n", len(r.Channels), r.Transaction)
		},
		OnError: func(err error) {
			fmt.Printf("Settlement error: %v\n", err)
		},
	})

	routes := x402http.RoutesConfig{
		"GET /api/generate": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  batched.SchemeBatched,
					Price:   maxPrice,
					Network: network,
					PayTo:   evmAddress,
				},
			},
			Description: "Batch-settlement demo — voucher updates session without per-request chain settle",
			MimeType:    "application/json",
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /api/generate", func(w http.ResponseWriter, r *http.Request) {
		// Charge a random fraction of maxPrice (1–100%) to demonstrate dynamic pricing.
		percent := 1 + rand.Intn(100)
		nethttpmw.SetSettlementOverrides(w, &x402.SettlementOverrides{
			Amount: fmt.Sprintf("%d%%", percent),
		})

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"result": "Here is your generated text...",
			"usage": map[string]string{
				"maxPrice":     maxPrice,
				"chargedRatio": fmt.Sprintf("%d%%", percent),
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

	fmt.Printf("Batch-settlement server listening at http://localhost:%s\n", defaultPort)
	fmt.Printf("  GET /api/generate\n")
	if cfg.ReceiverAuthorizerSigner != nil {
		fmt.Printf("  Receiver authorizer: local signer %s\n", cfg.ReceiverAuthorizerSigner.Address())
	} else {
		fmt.Println("  Receiver authorizer: facilitator")
	}

	server := &http.Server{Addr: ":" + defaultPort, Handler: handler}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("Server error: %v\n", err)
			os.Exit(1)
		}
	}()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	fmt.Println("\nShutting down — flushing pending claims...")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_ = manager.Stop(ctx, true)
	_ = server.Shutdown(ctx)
}
