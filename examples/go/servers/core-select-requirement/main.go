// Package main demonstrates selecting the matched payment requirement using core
// x402 server primitives only (no HTTP middleware, no facilitator client).
//
// Flow: register the authCapture scheme server → BuildPaymentRequirementsFromConfig per offer →
// decode PAYMENT-SIGNATURE → FindMatchingRequirements.
//
// Verify/settle are out of scope here; use mechanisms/evm/authCapture/facilitator in-process if needed.
package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	evm "github.com/x402-foundation/x402/go/mechanisms/evm"
	authcaptureserver "github.com/x402-foundation/x402/go/mechanisms/evm/authCapture/server"
	"github.com/x402-foundation/x402/go/types"
	"github.com/joho/godotenv"
)

const (
	network x402.Network = "eip155:8453"

	defaultCaptureAuthorizer = "0x6Ca3B21D18E2B60291413c99DD6969c43d26c3D2"
	defaultFeeRecipient      = "0x0000000000000000000000000000000000000000"
	defaultUSDCAddress       = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"
)

// srv is configured without a facilitator client — Initialize() is not required.
var srv = x402.Newx402ResourceServer(
	x402.WithSchemeServer(network, authcaptureserver.NewAuthCaptureEvmScheme()),
)

func main() {
	_ = godotenv.Load()

	receiver := os.Getenv("RECEIVER_ADDRESS")
	if receiver == "" {
		log.Fatal("RECEIVER_ADDRESS is required (merchant / pay-to address)")
	}

	addr := ":8080"
	if v := os.Getenv("LISTEN_ADDR"); v != "" {
		addr = v
	}

	http.HandleFunc("/paid", func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		payload, selected, offered, err := selectRequirement(ctx, r, receiver)
		if err != nil && payload == nil && offered == nil {
			http.Error(w, err.Error(), http.StatusInternalServerError)
			return
		}

		resourceInfo := &types.ResourceInfo{
			URL:         r.URL.String(),
			Description: "Example resource protected by authCapture scheme",
			MimeType:    "application/json",
		}

		// No payment header yet → 402 with offers.
		if payload == nil && err == nil {
			writePaymentRequired(w, offered, resourceInfo, "Payment required")
			return
		}
		if err != nil {
			writePaymentRequired(w, offered, resourceInfo, err.Error())
			return
		}

		// Matched offer — in production, verify/settle here (e.g. authCapture facilitator scheme).
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]interface{}{
			"status":                    "matched",
			"scheme":                    selected.Scheme,
			"network":                   selected.Network,
			"amount":                    selected.Amount,
			"payTo":                     selected.PayTo,
			"payloadAcceptedMatchesReq": payload.Accepted.Scheme == selected.Scheme,
		})
	})

	log.Printf("listening on %s (GET /paid)\n", addr)
	log.Fatal(http.ListenAndServe(addr, nil))
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

// offersFor returns ResourceConfigs for this handler. authCapture requires captureAuthorizer,
// captureDeadline, refundDeadline, feeRecipient, minFeeBps, and maxFeeBps in Extra.
func offersFor(receiver string) []x402.ResourceConfig {
	captureAuthorizer := envOrDefault("CAPTURE_AUTHORIZER", defaultCaptureAuthorizer)
	feeRecipient := envOrDefault("FEE_RECIPIENT", defaultFeeRecipient)
	usdc := envOrDefault("USDC_ADDRESS", defaultUSDCAddress)

	now := time.Now().Unix()
	captureDeadline := now + 3600   // 1 hour
	refundDeadline := now + 7 * 24 * 3600 // 7 days

	return []x402.ResourceConfig{{
		Scheme:            evm.SchemeAuthCapture,
		Network:           network,
		PayTo:             receiver,
		Price:             authCapturePrice(usdc, captureAuthorizer, feeRecipient, captureDeadline, refundDeadline),
		MaxTimeoutSeconds: 3600,
	}}
}

func authCapturePrice(usdc, captureAuthorizer, feeRecipient string, captureDeadline, refundDeadline int64) map[string]interface{} {
	return map[string]interface{}{
		"amount": "100000", // 0.10 USDC (6 decimals); adjust as needed
		"asset":  usdc,
		"extra": map[string]interface{}{
			"captureAuthorizer":   captureAuthorizer,
			"captureDeadline":     captureDeadline,
			"refundDeadline":      refundDeadline,
			"feeRecipient":        feeRecipient,
			"minFeeBps":           0,
			"maxFeeBps":           500,
			"assetTransferMethod": "eip3009",
		},
	}
}

// selectRequirement builds offered requirements, optionally parses PAYMENT-SIGNATURE, and
// returns the requirement entry matching the payload (same logic as HTTP server's FindMatchingRequirements).
func selectRequirement(ctx context.Context, r *http.Request, receiver string) (
	payload *types.PaymentPayload,
	selected *types.PaymentRequirements,
	offered []types.PaymentRequirements,
	err error,
) {
	var built []types.PaymentRequirements
	for _, cfg := range offersFor(receiver) {
		reqs, err := srv.BuildPaymentRequirementsFromConfig(ctx, cfg)
		if err != nil {
			return nil, nil, nil, fmt.Errorf("build requirements: %w", err)
		}
		built = append(built, reqs...)
	}

	header := r.Header.Get("PAYMENT-SIGNATURE")
	if header == "" {
		header = r.Header.Get("payment-signature")
	}
	if header == "" {
		return nil, nil, built, nil
	}

	jsonBytes, err := base64.StdEncoding.DecodeString(header)
	if err != nil {
		return nil, nil, built, fmt.Errorf("decode payment header: %w", err)
	}

	p, err := types.ToPaymentPayload(jsonBytes)
	if err != nil {
		return nil, nil, built, fmt.Errorf("parse payment payload: %w", err)
	}

	sel := srv.FindMatchingRequirements(built, *p)
	if sel == nil {
		return p, nil, built, fmt.Errorf("no matching payment requirement")
	}
	return p, sel, built, nil
}

func writePaymentRequired(w http.ResponseWriter, offered []types.PaymentRequirements, resource *types.ResourceInfo, msg string) {
	resp := srv.CreatePaymentRequiredResponse(offered, resource, msg, nil)
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusPaymentRequired)
	_ = json.NewEncoder(w).Encode(resp)
}
