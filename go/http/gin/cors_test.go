package gin

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

// appCORS stands in for an app-level CORS middleware registered before the
// payment middleware. It sets Allow-Origin and an expose list spread across two
// header values, with a payment header in a different case.
func appCORS(c *gin.Context) {
	c.Writer.Header().Set("Access-Control-Allow-Origin", "https://app.example")
	c.Writer.Header().Add("Access-Control-Expose-Headers", "X-Request-Id, payment-required")
	c.Writer.Header().Add("Access-Control-Expose-Headers", "X-Trace")
	c.Next()
}

func corsTestMiddleware(method string) gin.HandlerFunc {
	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{Success: true, Transaction: "0xtx", Network: "eip155:1", Payer: "0xpayer"}, nil
		},
	}
	routes := x402http.RoutesConfig{
		method + " /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"},
			},
		},
	}
	return PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", &mockSchemeServer{scheme: "exact"}),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
}

func assertExposeHeaders(t *testing.T, h http.Header, want string) {
	t.Helper()
	got := h.Values("Access-Control-Expose-Headers")
	if len(got) != 1 || got[0] != want {
		t.Errorf("Access-Control-Expose-Headers = %q, want [%q]", got, want)
	}
}

func assertAllowOrigin(t *testing.T, h http.Header, want []string) {
	t.Helper()
	got := h.Values("Access-Control-Allow-Origin")
	if len(got) != len(want) {
		t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, want)
		return
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, want)
			return
		}
	}
}

func TestPaymentMiddleware_CORS402ExposesPaymentHeaders(t *testing.T) {
	router := createTestRouter()
	router.Use(corsTestMiddleware("GET"))
	router.GET("/api", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest("GET", "/api", nil)
	req.Header.Set("Origin", "https://app.example")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("Expected status 402, got %d", w.Code)
	}
	assertExposeHeaders(t, w.Header(), "PAYMENT-REQUIRED, PAYMENT-RESPONSE")
	assertAllowOrigin(t, w.Header(), nil)
}

func TestPaymentMiddleware_CORS402MergesAppExposeList(t *testing.T) {
	router := createTestRouter()
	router.Use(appCORS)
	router.Use(corsTestMiddleware("GET"))
	router.GET("/api", func(c *gin.Context) { c.Status(http.StatusOK) })

	req := httptest.NewRequest("GET", "/api", nil)
	req.Header.Set("Origin", "https://app.example")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Fatalf("Expected status 402, got %d", w.Code)
	}
	if w.Header().Get("PAYMENT-REQUIRED") == "" {
		t.Error("Expected PAYMENT-REQUIRED header")
	}
	assertExposeHeaders(t, w.Header(), "X-Request-Id, payment-required, X-Trace, PAYMENT-RESPONSE")
	assertAllowOrigin(t, w.Header(), []string{"https://app.example"})
}

func TestPaymentMiddleware_CORSSettledResponseMergesExposeList(t *testing.T) {
	router := createTestRouter()
	router.Use(appCORS)
	router.Use(corsTestMiddleware("POST"))
	router.POST("/api", func(c *gin.Context) {
		c.Writer.Header().Add("Access-Control-Expose-Headers", "X-Handler, x-trace")
		c.JSON(http.StatusOK, gin.H{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("Origin", "https://app.example")
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}
	if w.Header().Get("PAYMENT-RESPONSE") == "" {
		t.Error("Expected PAYMENT-RESPONSE header")
	}
	assertExposeHeaders(t, w.Header(), "X-Request-Id, payment-required, X-Trace, X-Handler, PAYMENT-RESPONSE")
	assertAllowOrigin(t, w.Header(), []string{"https://app.example"})
}
