package echo

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
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
				settleFunc: tt.settle,
				supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
					return x402.SupportedResponse{
						Kinds:      []x402.SupportedKind{{X402Version: 2, Scheme: "exact", Network: "eip155:1"}},
						Extensions: []string{},
						Signers:    make(map[string][]string),
					}, nil
				},
			}

			routes := x402http.RoutesConfig{
				"GET /report": x402http.RouteConfig{
					Accepts: x402http.PaymentOptions{
						{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"},
					},
				},
			}

			e := createTestEcho()
			// Header set by an earlier middleware before the payment middleware runs.
			e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
				return func(c echo.Context) error {
					c.Response().Header().Set("Access-Control-Allow-Origin", "*")
					return next(c)
				}
			})
			e.Use(PaymentMiddlewareFromConfig(routes,
				WithFacilitatorClient(mockClient),
				WithScheme("eip155:1", &mockSchemeServer{scheme: "exact"}),
				WithSyncFacilitatorOnStart(true),
				WithTimeout(5*time.Second),
			))
			e.GET("/report", func(c echo.Context) error {
				c.SetCookie(&http.Cookie{Name: "session", Value: "paid"})
				c.Response().Header().Set("Content-Disposition", `attachment; filename="report.pdf"`)
				return c.Blob(http.StatusOK, "application/pdf", []byte("%PDF-1.4"))
			})

			req := httptest.NewRequest("GET", "/report", nil)
			req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
			req.Host = "example.com"

			w := httptest.NewRecorder()
			e.ServeHTTP(w, req)

			if w.Code != http.StatusPaymentRequired {
				t.Fatalf("Expected status 402, got %d", w.Code)
			}
			if got := w.Header().Values("Set-Cookie"); len(got) != 0 {
				t.Errorf("Expected no Set-Cookie on settlement failure, got %v", got)
			}
			if got := w.Header().Get("Content-Disposition"); got != "" {
				t.Errorf("Expected no Content-Disposition on settlement failure, got %q", got)
			}
			if got := w.Header().Get("Content-Type"); !strings.HasPrefix(got, "application/json") {
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
