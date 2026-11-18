// Batch-settlement resource server (EVM + SVM).
//
// Mirrors examples/typescript/servers/batch-settlement: optional EVM and/or SVM
// batch-settlement on GET /weather, with optional SVM server-signed metering
// when SVM_OPERATOR_PRIVATE_KEY is set.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"math/rand"
	"net/http"
	"os"
	"os/signal"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	nethttpmw "github.com/x402-foundation/x402/go/v2/http/nethttp"
	evmbatch "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	batchedserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/server"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	svmbatch "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	batchsvmserver "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
	svmsigners "github.com/x402-foundation/x402/go/v2/signers/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	defaultPort = "4021"
	maxPrice    = "$0.01"

	evmNetwork = x402.Network("eip155:84532")
	svmNetwork = x402.Network("solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1")
)

var evmAddressPattern = regexp.MustCompile(`^0x[0-9a-fA-F]{40}$`)

func main() {
	_ = godotenv.Load()

	evmAddress := strings.TrimSpace(os.Getenv("EVM_ADDRESS"))
	svmAddress := strings.TrimSpace(os.Getenv("SVM_ADDRESS"))
	if (evmAddress == "" || !evmAddressPattern.MatchString(evmAddress)) && svmAddress == "" {
		fmt.Println("Missing required EVM_ADDRESS or SVM_ADDRESS environment variable")
		os.Exit(1)
	}

	facilitatorURL := strings.TrimSpace(os.Getenv("FACILITATOR_URL"))
	if facilitatorURL == "" {
		fmt.Println("Missing required FACILITATOR_URL environment variable")
		os.Exit(1)
	}

	voucherStoreMode := batchedserver.VoucherStoreModeSelf
	if strings.EqualFold(strings.TrimSpace(os.Getenv("VOUCHER_STORE_MODE")), "facilitator") {
		voucherStoreMode = batchedserver.VoucherStoreModeFacilitator
	}

	withdrawDelay := 86400
	if v := strings.TrimSpace(os.Getenv("DEFERRED_WITHDRAW_DELAY_SECONDS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			withdrawDelay = n
		}
	}

	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	var (
		err                   error
		evmManager            *batchedserver.BatchSettlementChannelManager
		svmManager            *batchsvmserver.BatchChannelManager
		schemes               []nethttpmw.SchemeConfig
		accepts               x402http.PaymentOptions
		svmReceiverAuthorizer svm.ReceiverAuthorizerSigner
		svmOperator           svm.ReceiverAuthorizerSigner
	)

	if evmAddress != "" && evmAddressPattern.MatchString(evmAddress) {
		receiverAuthKey := strings.TrimSpace(os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"))
		storageDir := strings.TrimSpace(os.Getenv("STORAGE_DIR"))

		refundAuthKey := strings.TrimSpace(os.Getenv("EVM_REFUND_AUTHORIZER_PRIVATE_KEY"))

		if voucherStoreMode == batchedserver.VoucherStoreModeFacilitator && receiverAuthKey != "" {
			fmt.Println("VOUCHER_STORE_MODE=facilitator cannot be combined with EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")
			os.Exit(1)
		}

		cfg := &batchedserver.BatchSettlementEvmSchemeServerConfig{
			EnforceMinDeposit: false,
			VoucherStoreMode:  voucherStoreMode,
		}
		if voucherStoreMode == batchedserver.VoucherStoreModeSelf {
			cfg.WithdrawDelay = withdrawDelay
			if receiverAuthKey != "" {
				signer, err := newReceiverAuthorizerSigner(receiverAuthKey)
				if err != nil {
					fmt.Printf("Invalid EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
					os.Exit(1)
				}
				cfg.ReceiverAuthorizerSigner = signer
			}
		} else if refundAuthKey != "" {
			signer, err := newReceiverAuthorizerSigner(refundAuthKey)
			if err != nil {
				fmt.Printf("Invalid EVM_REFUND_AUTHORIZER_PRIVATE_KEY: %v\n", err)
				os.Exit(1)
			}
			cfg.RefundAuthorizerSigner = signer
		}
		if storageDir != "" {
			cfg.Storage = batchedserver.NewFileChannelStorage(evmbatch.FileChannelStorageOptions{
				Directory: storageDir,
			})
			// LockStorage is inferred from FileChannelStorage in self-managed mode.
			// Hosts that do not share STORAGE_DIR need an explicit LockStorage;
			// otherwise each host admits independently and only the charge CAS
			// protects revenue. Facilitator-managed Storage is a post-settle
			// replica only.
		}

		evmScheme := batchedserver.NewBatchSettlementEvmScheme(evmAddress, cfg)
		schemes = append(schemes, nethttpmw.SchemeConfig{Network: evmNetwork, Server: evmScheme})

		if voucherStoreMode == batchedserver.VoucherStoreModeSelf {
			evmManager = evmScheme.CreateChannelManager(facilitator, evmNetwork)
			evmManager.Start(batchedserver.AutoSettlementConfig{
				ClaimIntervalSecs:  60,
				SettleIntervalSecs: 120,
				RefundIntervalSecs: 180,
				MaxClaimsPerBatch:  100,
				SelectRefundChannels: func(channels []*batchedserver.ChannelSession, ctx batchedserver.AutoSettlementContext) ([]*batchedserver.ChannelSession, error) {
					out := make([]*batchedserver.ChannelSession, 0, len(channels))
					for _, c := range channels {
						if c.Balance == "" || c.Balance == "0" {
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
					fmt.Printf("[EVM] Claimed %d vouchers (tx: %s)\n", r.Vouchers, r.Transaction)
				},
				OnSettle: func(r batchedserver.SettleResult) {
					fmt.Printf("[EVM] Settled to %s (tx: %s)\n", evmAddress, r.Transaction)
				},
				OnRefund: func(r batchedserver.RefundResult) {
					fmt.Printf("[EVM] Refunded channel %s (tx: %s)\n", r.Channel, r.Transaction)
				},
				OnError: func(err error) {
					fmt.Printf("[EVM] Settlement error: %v\n", err)
				},
			})
		}

		accepts = append(accepts, x402http.PaymentOption{
			Scheme:  evmbatch.SchemeBatched,
			Price:   maxPrice,
			Network: evmNetwork,
			PayTo:   evmAddress,
		})
	}

	if svmAddress != "" {
		svmReceiverKey := strings.TrimSpace(os.Getenv("SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"))
		if svmReceiverKey == "" {
			fmt.Println("Missing required SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY environment variable")
			os.Exit(1)
		}
		svmReceiverAuthorizer, err = svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(svmReceiverKey)
		if err != nil {
			fmt.Printf("Invalid SVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
			os.Exit(1)
		}

		svmOperatorKey := strings.TrimSpace(os.Getenv("SVM_OPERATOR_PRIVATE_KEY"))
		if svmOperatorKey != "" {
			svmOperator, err = svmsigners.NewReceiverAuthorizerSignerFromPrivateKey(svmOperatorKey)
			if err != nil {
				fmt.Printf("Invalid SVM_OPERATOR_PRIVATE_KEY: %v\n", err)
				os.Exit(1)
			}
		}

		svmCfg := &batchsvmserver.Config{
			WithdrawDelay:      &withdrawDelay,
			ReceiverAuthorizer: svmReceiverAuthorizer,
			Store:              batchsvmserver.NewMemoryChannelStore(),
		}
		if svmOperator != nil {
			svmCfg.Operator = svmOperator
		}
		svmScheme := batchsvmserver.NewBatchSvmScheme(svmCfg)
		schemes = append(schemes, nethttpmw.SchemeConfig{Network: svmNetwork, Server: svmScheme})

		initCtx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		supported, err := facilitator.GetSupported(initCtx)
		if err != nil {
			fmt.Printf("Failed to fetch facilitator /supported: %v\n", err)
			os.Exit(1)
		}
		var svmKind *types.SupportedKind
		for i := range supported.Kinds {
			kind := supported.Kinds[i]
			if kind.Scheme == svmbatch.Scheme && kind.Network == string(svmNetwork) {
				svmKind = &supported.Kinds[i]
				break
			}
		}
		if svmKind != nil {
			baseRequirements := types.PaymentRequirements{
				Scheme:            svmbatch.Scheme,
				Network:           string(svmNetwork),
				Amount:            "10000",
				Asset:             svm.USDCDevnetAddress,
				PayTo:             svmAddress,
				MaxTimeoutSeconds: 300,
				Extra:             map[string]interface{}{},
			}
			svmRequirements, err := svmScheme.EnhancePaymentRequirements(initCtx, baseRequirements, *svmKind, nil)
			if err != nil {
				fmt.Printf("Failed to enhance SVM payment requirements: %v\n", err)
				os.Exit(1)
			}
			svmRPCURL := strings.TrimSpace(os.Getenv("SVM_RPC_URL"))
			svmManager, err = svmScheme.CreateChannelManager(facilitator, svmRequirements, batchsvmserver.BatchChannelManagerConfig{
				RPCURL: svmRPCURL,
				OnClaim: func(r batchsvmserver.ClaimResult) {
					fmt.Printf("[SVM] Claimed %d vouchers (tx: %s)\n", r.Vouchers, r.Transaction)
				},
				OnSettle: func(r batchsvmserver.SettleResult) {
					fmt.Printf("[SVM] Settled to %s (tx: %s)\n", svmAddress, r.Transaction)
				},
				OnSeal: func(r batchsvmserver.SealResult) {
					fmt.Printf("[SVM] Sealed channel %s (tx: %s)\n", r.Channel, r.Transaction)
				},
				OnError: func(err error) {
					fmt.Printf("[SVM] Settlement error: %v\n", err)
				},
			})
			if err != nil {
				fmt.Printf("Failed to create SVM channel manager: %v\n", err)
				os.Exit(1)
			}
			const svmRedemptionIntervalSecs = 60
			svmManager.Start(svmRedemptionIntervalSecs)
			maxIdle := svmKind.Extra[svmbatch.ExtraMaxIdleSecs]
			fmt.Printf(
				"[SVM] Redeeming every %ds; facilitator idle window: %vs\n",
				svmRedemptionIntervalSecs, formatAny(maxIdle),
			)
		} else {
			fmt.Println("[SVM] facilitator does not advertise batch-settlement; no redemption worker started")
		}

		accepts = append(accepts, x402http.PaymentOption{
			Scheme:  svmbatch.Scheme,
			Price:   maxPrice,
			Network: svmNetwork,
			PayTo:   svmAddress,
		})
		if svmOperator != nil {
			accepts = append(accepts, x402http.PaymentOption{
				Scheme:  svmbatch.Scheme,
				Price:   maxPrice,
				Network: svmNetwork,
				PayTo:   svmAddress,
				Extra: map[string]interface{}{
					svmbatch.ExtraVoucherSigner: svmbatch.VoucherSignerClient,
				},
			})
		}
	}

	routes := x402http.RoutesConfig{
		"GET /weather": {
			Accepts:     accepts,
			Description: "Weather data",
			MimeType:    "application/json",
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("GET /weather", func(w http.ResponseWriter, r *http.Request) {
		if payload, err := decodePaymentSignatureHeader(r); err == nil && payload != nil {
			accepted := payload.Accepted
			voucherSigner, _ := accepted.Extra[svmbatch.ExtraVoucherSigner].(string)
			if strings.HasPrefix(accepted.Network, "eip155:") || voucherSigner == svmbatch.VoucherSignerServer {
				chargedPercent := 1 + rand.Intn(100)
				nethttpmw.SetSettlementOverrides(w, &x402.SettlementOverrides{
					Amount: fmt.Sprintf("%d%%", chargedPercent),
				})
			}
		}

		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"report": map[string]any{
				"weather":     "sunny",
				"temperature": 70,
			},
		})
	})

	// Facilitator HTTP client defaults to 90s; batch settle on devnet can exceed 30s.
	paymentTimeout := 90 * time.Second
	if v := strings.TrimSpace(os.Getenv("PAYMENT_MIDDLEWARE_TIMEOUT_SECS")); v != "" {
		if secs, err := strconv.Atoi(v); err == nil && secs > 0 {
			paymentTimeout = time.Duration(secs) * time.Second
		}
	}

	handler := nethttpmw.X402Payment(nethttpmw.Config{
		Routes:      routes,
		Facilitator: facilitator,
		Schemes:     schemes,
		Timeout:     paymentTimeout,
	})(mux)

	port := strings.TrimSpace(os.Getenv("PORT"))
	if port == "" {
		port = defaultPort
	}

	server := &http.Server{Addr: ":" + port, Handler: handler, ReadHeaderTimeout: 10 * time.Second}
	go func() {
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			fmt.Printf("Server error: %v\n", err)
			os.Exit(1)
		}
	}()

	enabled := make([]string, 0, 2)
	if evmAddress != "" && evmAddressPattern.MatchString(evmAddress) {
		enabled = append(enabled, "EVM (Base Sepolia)")
	}
	if svmAddress != "" {
		enabled = append(enabled, "Solana (devnet)")
	}

	fmt.Printf("Batch-settlement server listening at http://localhost:%s\n", port)
	fmt.Printf("  GET /weather (%s)\n", strings.Join(enabled, ", "))
	if evmAddress != "" && evmAddressPattern.MatchString(evmAddress) {
		switch {
		case voucherStoreMode == batchedserver.VoucherStoreModeFacilitator:
			fmt.Println("  EVM voucher custody: facilitator-managed (pass-through verify/settle)")
			if strings.TrimSpace(os.Getenv("EVM_REFUND_AUTHORIZER_PRIVATE_KEY")) != "" {
				fmt.Println("  EVM refund authorizer: local signer configured")
			} else {
				fmt.Println("  EVM refund authorizer: facilitator delegatedRefund (402 omits refundAuthorizer)")
			}
		case strings.TrimSpace(os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY")) != "":
			fmt.Println("  EVM receiver authorizer: local signer configured")
		default:
			fmt.Println("  EVM receiver authorizer: facilitator")
		}
	}
	if svmAddress != "" {
		if svmReceiverAuthorizer != nil {
			fmt.Printf("  SVM receiver authorizer: local signer %s\n", svmReceiverAuthorizer.Address())
		} else {
			fmt.Println("  SVM receiver authorizer: facilitator")
		}
		if svmOperator != nil {
			fmt.Printf(
				"  SVM vouchers: server-signed by operator %s (client-signed accept offered alongside)\n",
				svmOperator.Address(),
			)
		} else {
			fmt.Println("  SVM vouchers: client-signed")
		}
	}
	fmt.Println()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	<-sigCh

	fmt.Println("Shutting down — flushing pending claims…")
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	if evmManager != nil {
		_ = evmManager.Stop(shutdownCtx, &batchedserver.StopOptions{Flush: true})
	}
	if svmManager != nil {
		_ = svmManager.Stop(shutdownCtx, batchsvmserver.StopOptions{Flush: true})
	}
	_ = server.Shutdown(shutdownCtx)
}

func decodePaymentSignatureHeader(r *http.Request) (*types.PaymentPayload, error) {
	header := r.Header.Get("PAYMENT-SIGNATURE")
	if header == "" {
		header = r.Header.Get("payment-signature")
	}
	if header == "" {
		header = r.Header.Get("X-PAYMENT")
	}
	if header == "" {
		return nil, nil
	}
	jsonBytes, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, err
	}
	version, err := types.DetectVersion(jsonBytes)
	if err != nil {
		return nil, err
	}
	if version != 2 {
		return nil, fmt.Errorf("only v2 payment signatures are supported")
	}
	return types.ToPaymentPayload(jsonBytes)
}

func formatAny(v interface{}) string {
	if v == nil {
		return "none"
	}
	return fmt.Sprint(v)
}
