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
	"github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	batchedserver "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement/server"
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

	// Default channel withdraw delay is 1 day when the env var is unset.
	withdrawDelay := 86400
	if v := os.Getenv("DEFERRED_WITHDRAW_DELAY_SECONDS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			withdrawDelay = n
		}
	}

	receiverAuthKey := os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
	storageDir := os.Getenv("STORAGE_DIR")

	cfg := &batchedserver.BatchSettlementEvmSchemeServerConfig{
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
		cfg.Storage = batchedserver.NewFileChannelStorage(batchsettlement.FileChannelStorageOptions{
			Directory: storageDir,
		})
	}

	scheme := batchedserver.NewBatchSettlementEvmScheme(evmAddress, cfg)

	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	manager := scheme.CreateChannelManager(facilitator, network)
	manager.Start(batchedserver.AutoSettlementConfig{
		ClaimIntervalSecs:  60,
		SettleIntervalSecs: 120,
		RefundIntervalSecs: 180,
		MaxClaimsPerBatch:  100,
		// Refund channels after 3 minutes of inactivity.
		SelectRefundChannels: func(channels []*batchedserver.ChannelSession, ctx batchedserver.AutoSettlementContext) ([]*batchedserver.ChannelSession, error) {
			out := make([]*batchedserver.ChannelSession, 0, len(channels))
			for _, c := range channels {
				if c.Balance == "" || c.Balance == "0" {
					continue
				}
				if c.PendingRequest != nil && c.PendingRequest.ExpiresAt > ctx.Now {
					continue
				}
				if ctx.Now-c.LastRequestTimestamp < 180_000 {
					continue
				}
				out = append(out, c)
			}
			return out, nil
		},
		OnClaim: func(r batchedserver.ClaimResult) {
			fmt.Printf("Claimed %d vouchers (tx: %s)\n", r.Vouchers, r.Transaction)
		},
		OnSettle: func(r batchedserver.SettleResult) {
			fmt.Printf("Settled to %s (tx: %s)\n", evmAddress, r.Transaction)
		},
		OnRefund: func(r batchedserver.RefundResult) {
			fmt.Printf("Refunded channel %s (tx: %s)\n", r.Channel, r.Transaction)
		},
		OnError: func(err error) {
			fmt.Printf("Settlement error: %v\n", err)
		},
	})

	// Flush pending channel work during interactive shutdown.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT)

	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  batchsettlement.SchemeBatched,
					Price:   maxPrice,
					Network: network,
					PayTo:   evmAddress,
				},
			},
			Description: "Weather data",
			MimeType:    "application/json",
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /weather", func(w http.ResponseWriter, r *http.Request) {
		// Bill a random fraction of maxPrice (1-100%) to demonstrate usage-based pricing.
		chargedPercent := 1 + rand.Intn(100)
		nethttpmw.SetSettlementOverrides(w, &x402.SettlementOverrides{
			Amount: fmt.Sprintf("%d%%", chargedPercent),
		})

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"report": map[string]any{
				"weather":     "sunny",
				"temperature": 70,
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

	server := &http.Server{Addr: ":" + defaultPort, Handler: handler}
	go func() {
		if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			fmt.Printf("Server error: %v\n", err)
			os.Exit(1)
		}
	}()

	fmt.Printf("Batch-settlement server listening at http://localhost:%s\n", defaultPort)
	fmt.Printf("  GET /weather\n")
	if cfg.ReceiverAuthorizerSigner != nil {
		fmt.Printf("  Receiver authorizer: local signer %s\n", cfg.ReceiverAuthorizerSigner.Address())
	} else {
		fmt.Println("  Receiver authorizer: facilitator")
	}

	<-sigCh

	fmt.Println("Shutting down — flushing pending claims…")
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	_ = manager.Stop(ctx, &batchedserver.StopOptions{Flush: true})
	_ = server.Shutdown(ctx)
}
