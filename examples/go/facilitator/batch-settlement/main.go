// Batch-settlement facilitator example (EVM + SVM).
//
// Registers the batch-settlement scheme on Base Sepolia and/or Solana Devnet.
// For SVM, wires BatchSvmRentCleanupManager to the scheme's channel storage so
// abandoned channels are sealed and rent is reclaimed asynchronously.
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedfac "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
	batchsvmfac "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/facilitator"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

const defaultPort = "4022"

const evmNetwork = "eip155:84532"
const svmNetwork = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1"

func main() {
	_ = godotenv.Load()

	port := envOr("PORT", defaultPort)

	evmPrivateKey := strings.TrimSpace(os.Getenv("EVM_PRIVATE_KEY"))
	svmPrivateKey := strings.TrimSpace(os.Getenv("SVM_PRIVATE_KEY"))
	evmRPCURL := envOr("EVM_RPC_URL", "https://sepolia.base.org")
	svmRPCURL := strings.TrimSpace(os.Getenv("SVM_RPC_URL"))
	svmArchiveRPCURL := strings.TrimSpace(os.Getenv("SVM_ARCHIVE_RPC_URL"))

	if evmPrivateKey == "" && svmPrivateKey == "" {
		fmt.Println("❌ At least one of EVM_PRIVATE_KEY or SVM_PRIVATE_KEY is required")
		os.Exit(1)
	}

	rentCleanupIntervalSecs := envInt("RENT_CLEANUP_INTERVAL_SECS", 30)
	abandonGraceSecs := envInt("RENT_CLEANUP_ABANDON_GRACE_SECS", 120)

	channelStorage := paymentchannels.NewInMemoryPaymentChannelStorage()

	facilitator := x402.Newx402Facilitator()
	facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
		if ctx.Result == nil {
			return nil
		}
		if ctx.Result.IsValid {
			fmt.Printf("✅ Verified payer=%s network=%s\n", ctx.Result.Payer, ctx.Payload.GetNetwork())
			return nil
		}
		fmt.Printf("❌ Verify failed payer=%s network=%s reason=%s message=%s\n",
			ctx.Result.Payer, ctx.Payload.GetNetwork(), ctx.Result.InvalidReason, ctx.Result.InvalidMessage)
		return nil
	})
	facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
		if ctx.Result == nil {
			return nil
		}
		if ctx.Result.Success {
			fmt.Printf("🎉 Settled network=%s tx=%s\n", ctx.Result.Network, ctx.Result.Transaction)
			return nil
		}
		fmt.Printf("⏳ Settle incomplete network=%s reason=%s tx=%s\n",
			ctx.Result.Network, ctx.Result.ErrorReason, ctx.Result.Transaction)
		return nil
	})
	facilitator.OnSettleFailure(func(ctx x402.FacilitatorSettleFailureContext) (*x402.FacilitatorSettleFailureHookResult, error) {
		fmt.Printf("❌ Settle error: %v\n", ctx.Error)
		return nil, nil
	})

	var rentCleanup *batchsvmfac.BatchSvmRentCleanupManager
	var stopRentCleanup context.CancelFunc

	var enabled []string

	if evmPrivateKey != "" {
		evmSigner, err := newFacilitatorEvmSigner(evmPrivateKey, evmRPCURL)
		if err != nil {
			fmt.Printf("Failed to create EVM signer: %v\n", err)
			os.Exit(1)
		}

		var authorizer batchsettlement.AuthorizerSigner
		receiverAuthorizerKey := strings.TrimSpace(os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"))
		if receiverAuthorizerKey != "" {
			authorizer, err = newAuthorizerSigner(receiverAuthorizerKey)
			if err != nil {
				fmt.Printf("Failed to create authorizer signer: %v\n", err)
				os.Exit(1)
			}
		}

		fmt.Printf("EVM Facilitator account: %s\n", evmSigner.GetAddresses()[0])
		if authorizer != nil {
			fmt.Printf("EVM Receiver Authorizer: %s\n", authorizer.Address())
		} else {
			fmt.Println("EVM Receiver Authorizer: not configured")
		}

		facilitator.Register(
			[]x402.Network{evmNetwork},
			batchedfac.NewBatchSettlementEvmScheme(evmSigner, authorizer),
		)
		enabled = append(enabled, "EVM (Base Sepolia)")
	}

	if svmPrivateKey != "" {
		rpcURL := svmRPCURL
		if rpcURL == "" {
			rpcURL = DefaultSvmRPC
		}

		svmSigner, err := newFacilitatorSvmSigner(svmPrivateKey, rpcURL)
		if err != nil {
			fmt.Printf("Failed to create SVM signer: %v\n", err)
			os.Exit(1)
		}

		fmt.Printf("SVM Facilitator account: %s\n", svmSigner.GetAddresses(context.Background(), svmNetwork)[0])

		svmConfig := &batchsvmfac.Config{
			ChannelStorage: channelStorage,
		}
		if svmArchiveRPCURL != "" {
			svmConfig.ReceiverBindingHistoryReader = batchsvmfac.NewReceiverBindingHistoryReader(map[string]string{
				svmNetwork: svmArchiveRPCURL,
			})
			fmt.Printf("SVM batch-settlement binding history RPC: %s\n", svmArchiveRPCURL)
		}
		scheme := batchsvmfac.NewBatchSvmScheme(context.Background(), svmSigner, svmConfig)
		facilitator.Register([]x402.Network{svmNetwork}, scheme)

		rentCleanup = scheme.CreateRentCleanupManager(x402.Network(svmNetwork))
		cleanupCtx, cancel := context.WithCancel(context.Background())
		stopRentCleanup = cancel
		rentCleanup.Start(cleanupCtx, batchsvmfac.StartConfig{
			Interval: time.Duration(rentCleanupIntervalSecs) * time.Second,
			RentCleanupOptions: batchsvmfac.CleanupOptions{
				AbandonGraceSecs: int64(abandonGraceSecs),
				OnClose: func(result batchsvmfac.CloseResult) {
					fmt.Printf("[rent-cleanup] %s channel=%s tx=%s\n",
						result.Action, result.ChannelID, result.Transaction)
				},
				OnReclaim: func(result batchsvmfac.ReclaimResult) {
					fmt.Printf("[rent-cleanup] reclaim channels=%s tx=%s\n",
						strings.Join(result.ChannelIDs, ","), result.Transaction)
				},
				OnError: func(err error, channelID string) {
					fmt.Printf("[rent-cleanup] error channel=%s: %v\n", channelID, err)
				},
			},
		})
		fmt.Printf(
			"SVM rent cleanup started (interval=%ds, abandonGrace=%ds)\n",
			rentCleanupIntervalSecs, abandonGraceSecs,
		)
		enabled = append(enabled, "Solana (devnet)")
	}

	mux := http.NewServeMux()

	mux.HandleFunc("GET /supported", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, facilitator.GetSupported())
	})

	mux.HandleFunc("POST /verify", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
		defer cancel()

		payload, requirements, err := readVerifyBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := facilitator.Verify(ctx, payload, requirements)
		if err != nil {
			fmt.Printf("Verify error: %v\n", err)
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})

	mux.HandleFunc("POST /settle", func(w http.ResponseWriter, r *http.Request) {
		ctx, cancel := context.WithTimeout(r.Context(), 60*time.Second)
		defer cancel()

		payload, requirements, err := readVerifyBody(r)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, map[string]string{"error": err.Error()})
			return
		}
		result, err := facilitator.Settle(ctx, payload, requirements)
		if err != nil {
			fmt.Printf("Settle error: %v\n", err)
			if strings.Contains(err.Error(), "Settlement aborted:") {
				writeJSON(w, http.StatusOK, x402.SettleResponse{
					Success:     false,
					ErrorReason: strings.TrimPrefix(err.Error(), "Settlement aborted: "),
					Network:     networkFromSettleBody(payload),
				})
				return
			}
			var settleErr *x402.SettleError
			if errors.As(err, &settleErr) && settleErr.ErrorReason != "" && settleErr.Transaction == "" {
				writeJSON(w, http.StatusOK, x402.SettleResponse{
					Success:     false,
					ErrorReason: settleErr.ErrorReason,
					Network:     settleErr.Network,
				})
				return
			}
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})

	server := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: 10 * time.Second,
	}

	go func() {
		signals := make(chan os.Signal, 1)
		signal.Notify(signals, syscall.SIGINT, syscall.SIGTERM)
		<-signals
		if stopRentCleanup != nil {
			stopRentCleanup()
		}
		if rentCleanup != nil {
			rentCleanup.Stop()
		}
		_ = server.Shutdown(context.Background())
	}()

	fmt.Printf("🚀 Batch-settlement facilitator listening on http://localhost:%s\n", port)
	fmt.Printf("   Networks: %s\n", strings.Join(enabled, ", "))
	fmt.Println()

	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		fmt.Printf("Server error: %v\n", err)
		os.Exit(1)
	}
}

func envOr(key, def string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return def
}

func envInt(key string, fallback int) int {
	value, err := strconv.Atoi(strings.TrimSpace(os.Getenv(key)))
	if err != nil || value <= 0 {
		return fallback
	}
	return value
}

func readVerifyBody(r *http.Request) (json.RawMessage, json.RawMessage, error) {
	var body struct {
		PaymentPayload      json.RawMessage `json:"paymentPayload"`
		PaymentRequirements json.RawMessage `json:"paymentRequirements"`
	}
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		return nil, nil, fmt.Errorf("invalid JSON body: %w", err)
	}
	if len(body.PaymentPayload) == 0 || len(body.PaymentRequirements) == 0 {
		return nil, nil, fmt.Errorf("missing paymentPayload or paymentRequirements")
	}
	return body.PaymentPayload, body.PaymentRequirements, nil
}

func networkFromSettleBody(payload json.RawMessage) x402.Network {
	var envelope struct {
		Network string `json:"network"`
	}
	if err := json.Unmarshal(payload, &envelope); err != nil || envelope.Network == "" {
		return "unknown"
	}
	return x402.Network(envelope.Network)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
