package nethttp

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

func TestPaymentMiddleware_DropsHandlerHeadersWhenSettlementFails(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{Success: false, ErrorReason: "Insufficient funds"}, nil
		},
		supportedFunc: defaultSupportedFunc(),
	}

	routes := x402http.RoutesConfig{
		"GET /report": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"},
			},
		},
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.SetCookie(w, &http.Cookie{Name: "session", Value: "paid"})
		w.Header().Set("Content-Disposition", `attachment; filename="report.pdf"`)
		w.Header().Set("Content-Type", "application/pdf")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("%PDF-1.4"))
	})

	paid := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", &mockSchemeServer{scheme: "exact"}),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)(handler)

	// Header set by an outer middleware before the payment middleware runs.
	wrapped := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		paid.ServeHTTP(w, r)
	})

	req := httptest.NewRequest("GET", "/report", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("Expected status 402, got %d", w.Code)
	}
	if got := w.Header().Values("Set-Cookie"); len(got) != 0 {
		t.Errorf("Expected no Set-Cookie on settlement failure, got %v", got)
	}
	if got := w.Header().Get("Content-Disposition"); got != "" {
		t.Errorf("Expected no Content-Disposition on settlement failure, got %q", got)
	}
	if got := w.Header().Get("Content-Type"); got != "application/json" {
		t.Errorf("Expected Content-Type application/json, got %q", got)
	}
	if got := w.Header().Get("Access-Control-Allow-Origin"); got != "*" {
		t.Errorf("Expected pre-handler header to survive, got %q", got)
	}
	if w.Header().Get("PAYMENT-RESPONSE") == "" {
		t.Error("Expected PAYMENT-RESPONSE header on settlement failure")
	}
}
