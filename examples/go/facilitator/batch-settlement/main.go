package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/joho/godotenv"
	x402 "github.com/x402-foundation/x402/go"
	batchedfac "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement/facilitator"
)

const defaultPort = "4022"

func main() {
	_ = godotenv.Load()

	port := envOr("PORT", defaultPort)

	evmPrivateKey := os.Getenv("EVM_PRIVATE_KEY")
	if evmPrivateKey == "" {
		fmt.Println("EVM_PRIVATE_KEY environment variable is required")
		os.Exit(1)
	}

	rpcURL := envOr("EVM_RPC_URL", "https://sepolia.base.org")

	// receiverAuthorizer signs ClaimBatch / Refund messages. Defaults to the same
	// key as the facilitator if a dedicated authorizer key isn't supplied.
	authKey := envOr("EVM_RECEIVER_AUTHORIZER_PRIVATE_KEY", evmPrivateKey)

	evmSigner, err := newFacilitatorEvmSigner(evmPrivateKey, rpcURL)
	if err != nil {
		fmt.Printf("Failed to create EVM signer: %v\n", err)
		os.Exit(1)
	}

	authorizer, err := newAuthorizerSigner(authKey)
	if err != nil {
		fmt.Printf("Failed to create authorizer signer: %v\n", err)
		os.Exit(1)
	}

	fmt.Printf("EVM Facilitator account: %s\n", evmSigner.GetAddresses()[0])
	fmt.Printf("EVM Receiver Authorizer: %s\n", authorizer.Address())

	facilitator := x402.Newx402Facilitator()
	facilitator.Register(
		[]x402.Network{"eip155:84532"},
		batchedfac.NewBatchSettlementEvmScheme(evmSigner, authorizer),
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

	fmt.Printf("Facilitator listening on http://localhost:%s\n", port)
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
