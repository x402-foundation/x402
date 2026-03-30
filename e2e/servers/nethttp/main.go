package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/extensions/bazaar"
	"github.com/coinbase/x402/go/extensions/eip2612gassponsor"
	"github.com/coinbase/x402/go/extensions/erc20approvalgassponsor"
	"github.com/coinbase/x402/go/extensions/types"
	x402http "github.com/coinbase/x402/go/http"
	nethttpmw "github.com/coinbase/x402/go/http/nethttp"
	exactevm "github.com/coinbase/x402/go/mechanisms/evm/exact/server"
	uptoevm "github.com/coinbase/x402/go/mechanisms/evm/upto/server"
	svm "github.com/coinbase/x402/go/mechanisms/svm/exact/server"
	"github.com/joho/godotenv"
)

var shutdownRequested bool

// net/http E2E Test Server with x402 v2 Payment Middleware
//
// This server demonstrates how to integrate x402 v2 payment middleware
// with a standard net/http application for end-to-end testing.

func main() {
	// Load .env file if it exists
	if err := godotenv.Load(); err != nil {
		fmt.Println("Warning: .env file not found. Using environment variables.")
	}

	// Get configuration from environment
	port := os.Getenv("PORT")
	if port == "" {
		port = "4021"
	}

	evmPayeeAddress := os.Getenv("EVM_PAYEE_ADDRESS")
	if evmPayeeAddress == "" {
		fmt.Println("❌ EVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	svmPayeeAddress := os.Getenv("SVM_PAYEE_ADDRESS")
	if svmPayeeAddress == "" {
		fmt.Println("❌ SVM_PAYEE_ADDRESS environment variable is required")
		os.Exit(1)
	}

	facilitatorURL := os.Getenv("FACILITATOR_URL")
	if facilitatorURL == "" {
		fmt.Println("❌ FACILITATOR_URL environment variable is required")
		os.Exit(1)
	}

	// Network configurations (from env or defaults)
	evmNetworkStr := os.Getenv("EVM_NETWORK")
	if evmNetworkStr == "" {
		evmNetworkStr = "eip155:84532" // Default: Base Sepolia
	}
	svmNetworkStr := os.Getenv("SVM_NETWORK")
	if svmNetworkStr == "" {
		svmNetworkStr = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" // Default: Solana Devnet
	}
	evmNetwork := x402.Network(evmNetworkStr)
	svmNetwork := x402.Network(svmNetworkStr)

	evmPermit2Asset := os.Getenv("EVM_PERMIT2_ASSET")
	if evmPermit2Asset == "" {
		evmPermit2Asset = "0x036CbD53842c5426634e7929541eC2318f3dCF7e"
	}

	fmt.Printf("EVM Payee address: %s\n", evmPayeeAddress)
	fmt.Printf("SVM Payee address: %s\n", svmPayeeAddress)
	fmt.Printf("Using remote facilitator at: %s\n", facilitatorURL)

	// Create HTTP facilitator client
	facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	// Configure x402 payment middleware
	//
	// This middleware protects /exact/* payment routes with USDC payment requirements
	// on the Base Sepolia testnet with bazaar discovery extension.

	// Declare bazaar discovery extension for GET endpoints
	discoveryExtension, err := bazaar.DeclareDiscoveryExtension(
		bazaar.MethodGET,
		nil, // No query params
		nil, // No input schema
		"",  // No body type (GET method)
		&types.OutputConfig{
			Example: map[string]interface{}{
				"message":   "Protected endpoint accessed successfully",
				"timestamp": "2024-01-01T00:00:00Z",
			},
			Schema: types.JSONSchema{
				"properties": map[string]interface{}{
					"message":   map[string]interface{}{"type": "string"},
					"timestamp": map[string]interface{}{"type": "string"},
				},
				"required": []string{"message", "timestamp"},
			},
		},
	)
	if err != nil {
		fmt.Printf("Warning: Failed to create bazaar extension: %v\n", err)
	}

	routes := x402http.RoutesConfig{
		"GET /exact/evm/eip3009": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   evmPayeeAddress,
					Price:   "$0.001",
					Network: evmNetwork,
				},
			},
			Extensions: map[string]interface{}{
				types.BAZAAR.Key(): discoveryExtension,
			},
		},
		"GET /exact/svm": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   svmPayeeAddress,
					Price:   "$0.001",
					Network: svmNetwork,
				},
			},
			Extensions: map[string]interface{}{
				types.BAZAAR.Key(): discoveryExtension,
			},
		},
		"GET /exact/evm/permit2": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   evmPayeeAddress,
					Network: evmNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
						},
					},
				},
			},
			Extensions: map[string]interface{}{
				types.BAZAAR.Key(): discoveryExtension,
			},
		},
		"GET /exact/evm/permit2-eip2612GasSponsoring": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   evmPayeeAddress,
					Network: evmNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  evmPermit2Asset,
						"extra": func() map[string]interface{} {
							name := "USD Coin"
							if evmNetworkStr == "eip155:84532" {
								name = "USDC"
							}
							return map[string]interface{}{
								"assetTransferMethod": "permit2",
								"name":                name,
								"version":             "2",
							}
						}(),
					},
				},
			},
			Extensions: func() map[string]interface{} {
				ext := map[string]interface{}{
					types.BAZAAR.Key(): discoveryExtension,
				}
				for k, v := range eip2612gassponsor.DeclareEip2612GasSponsoringExtension() {
					ext[k] = v
				}
				return ext
			}(),
		},
		"GET /upto/evm/permit2": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "upto",
					PayTo:   evmPayeeAddress,
					Network: evmNetwork,
					Price: map[string]interface{}{
						"amount": "2000",
						"asset":  evmPermit2Asset,
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
							"name":                "USDC",
							"version":             "2",
						},
					},
				},
			},
			Extensions: func() map[string]interface{} {
				ext := map[string]interface{}{
					types.BAZAAR.Key(): discoveryExtension,
				}
				for k, v := range eip2612gassponsor.DeclareEip2612GasSponsoringExtension() {
					ext[k] = v
				}
				return ext
			}(),
		},
		"GET /exact/evm/permit2-erc20ApprovalGasSponsoring": {
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   evmPayeeAddress,
					Network: evmNetwork,
					Price: map[string]interface{}{
						"amount": "1000",
						"asset":  evmPermit2Asset,
						"extra": map[string]interface{}{
							"assetTransferMethod": "permit2",
						},
					},
				},
			},
			Extensions: func() map[string]interface{} {
				ext := map[string]interface{}{
					types.BAZAAR.Key(): discoveryExtension,
				}
				for k, v := range erc20approvalgassponsor.DeclareExtension() {
					ext[k] = v
				}
				return ext
			}(),
		},
	}

	// Create ServeMux and register handlers
	mux := http.NewServeMux()

	// Protected endpoint - requires payment to access
	mux.HandleFunc("GET /exact/evm/eip3009", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Protected endpoint accessed successfully (EVM)",
			"timestamp": time.Now().Format(time.RFC3339),
			"network":   "eip155:84532",
		})
	})

	// Protected SVM endpoint - requires payment to access
	mux.HandleFunc("GET /exact/svm", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Protected endpoint accessed successfully (SVM)",
			"timestamp": time.Now().Format(time.RFC3339),
			"network":   "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
		})
	})

	// Protected Permit2 direct endpoint - standard settle (no gas sponsoring)
	mux.HandleFunc("GET /exact/evm/permit2", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Permit2 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2",
		})
	})

	// Protected Permit2 EIP-2612 endpoint - Permit2 with gas sponsoring
	mux.HandleFunc("GET /exact/evm/permit2-eip2612GasSponsoring", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Permit2 EIP-2612 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2-eip2612",
		})
	})

	// Protected Permit2 ERC-20 approval endpoint
	mux.HandleFunc("GET /exact/evm/permit2-erc20ApprovalGasSponsoring", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Permit2 ERC-20 approval endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "permit2-erc20-approval",
		})
	})

	mux.HandleFunc("GET /upto/evm/permit2", func(w http.ResponseWriter, r *http.Request) {
		if shutdownRequested {
			writeJSON(w, http.StatusServiceUnavailable, map[string]interface{}{
				"error": "Server shutting down",
			})
			return
		}

		nethttpmw.SetSettlementOverrides(w, &x402.SettlementOverrides{Amount: "1000"})

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message":   "Upto Permit2 endpoint accessed successfully",
			"timestamp": time.Now().Format(time.RFC3339),
			"method":    "upto-permit2",
		})
	})

	// Health check endpoint - no payment required
	mux.HandleFunc("GET /health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]interface{}{
			"status":      "ok",
			"version":     "2.0.0",
			"evm_network": string(evmNetwork),
			"evm_payee":   evmPayeeAddress,
			"svm_network": string(svmNetwork),
			"svm_payee":   svmPayeeAddress,
		})
	})

	// Shutdown endpoint - used by e2e tests
	mux.HandleFunc("POST /close", func(w http.ResponseWriter, r *http.Request) {
		shutdownRequested = true

		writeJSON(w, http.StatusOK, map[string]interface{}{
			"message": "Server shutting down gracefully",
		})
		fmt.Println("Received shutdown request")

		// Schedule server shutdown after response
		go func() {
			time.Sleep(100 * time.Millisecond)
			os.Exit(0)
		}()
	})

	// Apply payment middleware with detailed error logging
	handler := nethttpmw.X402Payment(nethttpmw.Config{
		Routes:      routes,
		Facilitator: facilitatorClient,
		Schemes: []nethttpmw.SchemeConfig{
			{Network: evmNetwork, Server: exactevm.NewExactEvmScheme()},
			{Network: evmNetwork, Server: uptoevm.NewUptoEvmScheme()},
			{Network: svmNetwork, Server: svm.NewExactSvmScheme()},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			// Log detailed error information for debugging
			fmt.Printf("❌ [E2E SERVER ERROR] Payment error occurred\n")
			fmt.Printf("   Path: %s\n", r.URL.Path)
			fmt.Printf("   Method: %s\n", r.Method)
			fmt.Printf("   Error: %v\n", err)
			fmt.Printf("   Headers: %v\n", r.Header)

			// Default error response
			writeJSON(w, http.StatusPaymentRequired, map[string]interface{}{
				"error": err.Error(),
			})
		},
		SettlementHandler: func(w http.ResponseWriter, r *http.Request, settleResp *x402.SettleResponse) {
			// Log successful settlement
			fmt.Printf("✅ [E2E SERVER SUCCESS] Payment settled\n")
			fmt.Printf("   Path: %s\n", r.URL.Path)
			fmt.Printf("   Transaction: %s\n", settleResp.Transaction)
			fmt.Printf("   Network: %s\n", settleResp.Network)
			fmt.Printf("   Payer: %s\n", settleResp.Payer)
		},
	})(mux)

	// Set up graceful shutdown
	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		<-quit
		fmt.Println("Received shutdown signal, exiting...")
		os.Exit(0)
	}()

	// Print startup banner
	fmt.Printf(`
╔════════════════════════════════════════════════════════╗
║           x402 net/http E2E Test Server                ║
╠════════════════════════════════════════════════════════╣
║  Server:     http://localhost:%-29s ║
║  EVM Network: %-40s ║
║  EVM Payee:   %-40s ║
║  SVM Network: %-40s ║
║  SVM Payee:   %-40s ║
║                                                        ║
║  Endpoints:                                            ║
║  • GET  /exact/evm/eip3009                    (EVM EIP-3009)  ║
║  • GET  /exact/evm/permit2                    (Permit2)       ║
║  • GET  /exact/evm/permit2-eip2612GasSponsoring               ║
║  • GET  /exact/evm/permit2-erc20ApprovalGasSponsoring         ║
║  • GET  /exact/svm                            (SVM)           ║
║  • GET  /health                 (no payment required)  ║
║  • POST /close                  (shutdown server)      ║
╚════════════════════════════════════════════════════════╝
`, port, evmNetwork, evmPayeeAddress, svmNetwork, svmPayeeAddress)

	server := &http.Server{
		Addr:    ":" + port,
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
