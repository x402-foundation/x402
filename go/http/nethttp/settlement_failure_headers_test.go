package nethttp

import (
	"bytes"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

func TestPaymentMiddleware_DropsHandlerHeadersWhenSettlementFails(t *testing.T) {
	tests := []struct {
		name   string
		settle func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error)
	}{
		{
			name: "settle returns failure",
			settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
				return &x402.SettleResponse{Success: false, ErrorReason: "Insufficient funds"}, nil
			},
		},
		{
			name: "settle returns error",
			settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
				return nil, errors.New("facilitator unavailable")
			},
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			mockClient := &mockFacilitatorClient{
				verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
					return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
				},
				settleFunc:    tt.settle,
				supportedFunc: defaultSupportedFunc(),
			}

			routes := x402http.RoutesConfig{
				"GET /report.pdf": x402http.RouteConfig{
					Accepts: x402http.PaymentOptions{
						{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"},
					},
				},
			}

			// http.ServeContent sets Content-Length, Last-Modified and Accept-Ranges
			// for the file it serves.
			handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				http.SetCookie(w, &http.Cookie{Name: "session", Value: "paid"})
				w.Header().Set("Content-Disposition", `attachment; filename="report.pdf"`)
				http.ServeContent(w, r, "report.pdf", time.Unix(1700000000, 0), bytes.NewReader([]byte("%PDF-1.4")))
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

			req := httptest.NewRequest("GET", "/report.pdf", nil)
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
			for _, name := range []string{"Content-Disposition", "Content-Length", "Last-Modified"} {
				if got := w.Header().Get(name); got != "" {
					t.Errorf("Expected no %s on settlement failure, got %q", name, got)
				}
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
		})
	}
}
