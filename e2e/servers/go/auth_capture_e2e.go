package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"sort"

	authcaptureserver "github.com/x402-foundation/x402/go/v2/mechanisms/evm/auth-capture/server"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

// AuthCaptureE2eCapturePath is the harness-only deferred capture endpoint.
const AuthCaptureE2eCapturePath = "/__e2e/auth-capture/capture"

var authCaptureEvmScheme *authcaptureserver.AuthCaptureEvmScheme

func setAuthCaptureEvmScheme(scheme *authcaptureserver.AuthCaptureEvmScheme) {
	authCaptureEvmScheme = scheme
}

type authCaptureCaptureRequest struct {
	Path string `json:"path"`
}

type authCaptureCaptureResponse struct {
	Success         bool   `json:"success"`
	Transaction     string `json:"transaction,omitempty"`
	PaymentInfoHash string `json:"paymentInfoHash,omitempty"`
	Path            string `json:"path,omitempty"`
	ErrorReason     string `json:"errorReason,omitempty"`
}

// HandleAuthCaptureE2eCapture triggers lifecycle capture for the latest stored payment.
func HandleAuthCaptureE2eCapture(facilitator *x402http.HTTPFacilitatorClient, body []byte) (int, interface{}) {
	if authCaptureEvmScheme == nil {
		return http.StatusNotImplemented, map[string]string{"error": "Auth-capture lifecycle is not configured on this server"}
	}

	var req authCaptureCaptureRequest
	if len(body) > 0 {
		_ = json.Unmarshal(body, &req)
	}

	manager := authCaptureEvmScheme.NewLifecycleManager(facilitator)
	ctx := context.Background()
	payments, err := manager.List(ctx)
	if err != nil {
		return http.StatusInternalServerError, map[string]string{"error": err.Error()}
	}
	if len(payments) == 0 {
		return http.StatusNotFound, map[string]string{"error": "No authorized payments in storage"}
	}

	sort.Slice(payments, func(i, j int) bool {
		return payments[i].CreatedAt.After(payments[j].CreatedAt)
	})
	record := payments[0]

	settle, err := manager.Capture(ctx, record.PaymentInfoHash, nil)
	if err != nil {
		return http.StatusInternalServerError, map[string]string{"error": err.Error()}
	}

	resp := authCaptureCaptureResponse{
		Success:         settle != nil && settle.Success,
		Transaction:     settleTransaction(settle),
		PaymentInfoHash: record.PaymentInfoHash,
		Path:            req.Path,
	}
	if settle != nil && settle.ErrorReason != "" {
		resp.ErrorReason = settle.ErrorReason
	}
	return http.StatusOK, resp
}

func settleTransaction(settle *x402.SettleResponse) string {
	if settle == nil {
		return ""
	}
	return settle.Transaction
}

// RegisterAuthCaptureE2eCapture registers POST /__e2e/auth-capture/capture on a net/http mux.
func RegisterAuthCaptureE2eCapture(mux *http.ServeMux, facilitator *x402http.HTTPFacilitatorClient) {
	mux.HandleFunc("POST "+AuthCaptureE2eCapturePath, func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		status, payload := HandleAuthCaptureE2eCapture(facilitator, body)
		writeJSON(w, status, payload)
	})
}

func writeJSON(w http.ResponseWriter, status int, payload interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(payload)
}
