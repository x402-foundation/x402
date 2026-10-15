package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	authcapture "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture"
	authcapturefac "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
	evmsigners "github.com/x402-foundation/x402/go/v2/signers/evm"
)

const defaultPort = "4022"

// Auth-capture facilitator demo: acts as the escrow operator (captureAuthorizer),
// authorizing holds and relaying the server's capture or void. When
// EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY is set, it also advertises extra.receiverAuthorizer
// and signs delegated charge and lifecycle payloads with an explicit
// InMemoryAuthCaptureDelegatedAuthStorage and OnStorageError (all four delegation fields
// are required to opt in).
func main() {
	_ = godotenv.Load()

	port := envOr("PORT", defaultPort)

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	rpcURL := envOr("EVM_RPC_URL", "https://sepolia.base.org")

	evmSigner, err := newFacilitatorEvmSigner(evmPrivateKey, rpcURL)
	if err != nil {
		fmt.Printf("Failed to create EVM signer: %v\n", err)
		os.Exit(1)
	}

	feeRecipient := os.Getenv("FEE_RECIPIENT")
	minFeeBps := atoiOr("MIN_FEE_BPS", 0)
	maxFeeBps := atoiOr("MAX_FEE_BPS", 0)

	config := authcapturefac.AuthCaptureEvmSchemeConfig{
		// /supported advertises one of the signer's addresses per response.
		CaptureAuthorizers: evmSigner.GetAddresses(),
		FeeRecipient:       feeRecipient,
		MinFeeBps:          uint16(minFeeBps),
		MaxFeeBps:          uint16(maxFeeBps),
	}

	// Custom operators are admitted per address. An empty list admits none, leaving
	// only "delegated" routes through the relayer.
	customOperators := parseCommaSeparatedList(os.Getenv("CUSTOM_OPERATOR_ALLOWLIST"))
	for _, addr := range customOperators {
		if !evm.IsValidAddress(addr) {
			fmt.Printf(
				"Invalid CUSTOM_OPERATOR_ALLOWLIST entry \"%s\" (comma-separated 20-byte hex addresses, 0x-prefixed)\n",
				addr,
			)
			os.Exit(1)
		}
	}
	if len(customOperators) > 0 {
		config.Operators = make([]authcapturefac.OperatorAllowlistEntry, len(customOperators))
		for i, addr := range customOperators {
			config.Operators[i] = authcapturefac.OperatorAllowlistEntry{
				Address:      evm.NormalizeAddress(addr),
				OperatorType: authcapture.OperatorTypeCustom,
			}
		}
		config.CustomOperatorGasLimit = authcapture.DefaultCustomOperatorGasLimit
	}

	// Optional dedicated receiver authorizer (recommended: separate from the relayer).
	var receiverAuthorizer evm.ClientEvmSigner
	if receiverAuthorizerKey := os.Getenv("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY"); receiverAuthorizerKey != "" {
		receiverAuthorizer, err = evmsigners.NewClientSignerFromPrivateKey(receiverAuthorizerKey)
		if err != nil {
			fmt.Printf("Invalid EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY: %v\n", err)
			os.Exit(1)
		}
		config.AuthorizerSigner = receiverAuthorizer
		config.DelegatedAuthStorage = authcapturefac.NewInMemoryAuthCaptureDelegatedAuthStorage()
		// SDK hook: called during delegated /settle (see DelegatedSettleContext).
		// Authenticate the resource server (API key, mTLS, JWT, etc.) using the context and
		// return a stable merchant id, or an empty string to reject. Local testing only:
		config.ResolveCallerIdentity = func(_ context.Context, _ authcapturefac.DelegatedSettleContext) (string, error) {
			return "example-local-caller", nil
		}
		config.OnStorageError = func(err error, network x402.Network, paymentInfoHash string) {
			fmt.Printf("[delegated-auth-storage] network=%s paymentInfoHash=%s error=%v\n", network, paymentInfoHash, err)
		}
	}

	scheme, err := authcapturefac.NewAuthCaptureEvmSchemeWithError(evmSigner, config)
	if err != nil {
		fmt.Printf("Invalid auth-capture facilitator config: %v\n", err)
		os.Exit(1)
	}

	facilitator := x402.Newx402Facilitator()
	facilitator.Register([]x402.Network{"eip155:84532"}, scheme)

	facilitator.OnAfterVerify(func(ctx x402.FacilitatorVerifyResultContext) error {
		fmt.Printf("Payment verified\n")
		return nil
	})
	facilitator.OnAfterSettle(func(ctx x402.FacilitatorSettleResultContext) error {
		fmt.Printf("Payment settled: %s\n", ctx.Result.Transaction)
		return nil
	})

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
			writeSettleError(w, err)
			return
		}
		writeJSON(w, http.StatusOK, result)
	})

	fmt.Printf("Auth-capture facilitator listening on http://localhost:%s\n", port)
	fmt.Printf("  Capture authorizer pool (operator): %s\n", strings.Join(config.CaptureAuthorizers, ", "))
	if receiverAuthorizer != nil {
		fmt.Printf("  Receiver authorizer: %s\n", receiverAuthorizer.Address())
		fmt.Println("  Delegated auth bindings: InMemoryAuthCaptureDelegatedAuthStorage (process-local)")
		fmt.Println("  Delegated settles: ResolveCallerIdentity returns example-local-caller (local only)")
	} else {
		fmt.Println("  Receiver authorizer: not configured (resource servers must self-sign)")
	}
	if len(customOperators) > 0 {
		fmt.Printf("  Custom operators admitted: %s\n", strings.Join(customOperators, ", "))
	} else {
		fmt.Println("  Custom operators: none admitted")
	}
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		fmt.Printf("Server error: %v\n", err)
		os.Exit(1)
	}
}

func parseCommaSeparatedList(raw string) []string {
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, part := range parts {
		part = strings.TrimSpace(part)
		if part != "" {
			out = append(out, part)
		}
	}
	return out
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func atoiOr(key string, def int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
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

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
