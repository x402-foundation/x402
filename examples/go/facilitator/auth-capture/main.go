package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go/v2"
	authcapturefac "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/facilitator"
)

const defaultPort = "4022"

// Auth-capture facilitator demo: acts as the escrow operator (captureAuthorizer),
// authorizing holds and relaying the server's signed capture or void.
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
		CaptureAuthorizer: evmSigner.GetAddresses()[0],
		FeeRecipient:      feeRecipient,
		MinFeeBps:         uint16(minFeeBps),
		MaxFeeBps:         uint16(maxFeeBps),
	}

	facilitator := x402.Newx402Facilitator()
	facilitator.Register(
		[]x402.Network{"eip155:84532"},
		authcapturefac.NewAuthCaptureEvmScheme(evmSigner, config),
	)

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
			writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
			return
		}
		writeJSON(w, http.StatusOK, result)
	})

	fmt.Printf("Auth-capture facilitator listening on http://localhost:%s\n", port)
	fmt.Printf("  Capture authorizer (operator): %s\n", config.CaptureAuthorizer)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		fmt.Printf("Server error: %v\n", err)
		os.Exit(1)
	}
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
