package echo

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/labstack/echo/v4"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/types"
)

// ============================================================================
// Mock Implementations
// ============================================================================

// mockSchemeServer implements x402.SchemeNetworkServer for testing
type mockSchemeServer struct {
	scheme string
}

func (m *mockSchemeServer) Scheme() string {
	return m.scheme
}

func (m *mockSchemeServer) ParsePrice(price x402.Price, network x402.Network) (x402.AssetAmount, error) {
	return x402.AssetAmount{
		Asset:  "USDC",
		Amount: "1000000",
	}, nil
}

func (m *mockSchemeServer) EnhancePaymentRequirements(ctx context.Context, base types.PaymentRequirements, supported types.SupportedKind, extensions []string) (types.PaymentRequirements, error) {
	return base, nil
}

// mockFacilitatorClient implements x402.FacilitatorClient for testing
type mockFacilitatorClient struct {
	verifyFunc    func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error)
	settleFunc    func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error)
	supportedFunc func(ctx context.Context) (x402.SupportedResponse, error)
}

func (m *mockFacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	if m.verifyFunc != nil {
		return m.verifyFunc(ctx, payloadBytes, requirementsBytes)
	}
	return &x402.VerifyResponse{IsValid: true, Payer: "0xmock"}, nil
}

func (m *mockFacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
	if m.settleFunc != nil {
		return m.settleFunc(ctx, payloadBytes, requirementsBytes)
	}
	return &x402.SettleResponse{Success: true, Transaction: "0xtx", Network: "eip155:1", Payer: "0xmock"}, nil
}

func (m *mockFacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	if m.supportedFunc != nil {
		return m.supportedFunc(ctx)
	}
	return x402.SupportedResponse{
		Kinds: []x402.SupportedKind{
			{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
		},
		Extensions: []string{},
		Signers:    make(map[string][]string),
	}, nil
}

func (m *mockFacilitatorClient) Identifier() string {
	return "mock"
}

// ============================================================================
// Test Helpers
// ============================================================================

// createTestEcho creates an Echo instance for testing
func createTestEcho() *echo.Echo {
	e := echo.New()
	return e
}

// createPaymentHeader creates a base64-encoded payment header for testing
//
//nolint:unparam // payTo is always "0xtest" in current tests but keeping param for flexibility
func createPaymentHeader(payTo string) string {
	payload := x402.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"sig": "test"},
		Accepted: x402.PaymentRequirements{
			Scheme:            "exact",
			Network:           "eip155:1",
			Asset:             "USDC",
			Amount:            "1000000",
			PayTo:             payTo,
			MaxTimeoutSeconds: 300,
			Extra: map[string]interface{}{
				"resourceUrl": "http://example.com/api",
			},
		},
	}

	payloadJSON, _ := json.Marshal(payload)
	return base64.StdEncoding.EncodeToString(payloadJSON)
}

// ============================================================================
// EchoAdapter Tests
// ============================================================================

func TestEchoAdapter_GetHeader(t *testing.T) {
	e := createTestEcho()
	var adapter *EchoAdapter

	e.GET("/test", func(c echo.Context) error {
		adapter = NewEchoAdapter(c)
		return c.NoContent(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("X-Custom-Header", "test-value")
	req.Header.Set("payment-signature", "sig-data")

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if adapter.GetHeader("X-Custom-Header") != "test-value" {
		t.Error("Expected X-Custom-Header to be 'test-value'")
	}

	if adapter.GetHeader("Payment-Signature") != "sig-data" {
		t.Error("Expected payment-signature header")
	}
}

func TestEchoAdapter_GetMethod(t *testing.T) {
	tests := []struct {
		method   string
		expected string
	}{
		{"GET", "GET"},
		{"POST", "POST"},
		{"PUT", "PUT"},
		{"DELETE", "DELETE"},
	}

	for _, tt := range tests {
		t.Run(tt.method, func(t *testing.T) {
			e := createTestEcho()
			var adapter *EchoAdapter

			e.Add(tt.method, "/test", func(c echo.Context) error {
				adapter = NewEchoAdapter(c)
				return c.NoContent(http.StatusOK)
			})

			req := httptest.NewRequest(tt.method, "/test", nil)
			w := httptest.NewRecorder()
			e.ServeHTTP(w, req)

			if adapter.GetMethod() != tt.expected {
				t.Errorf("Expected method %s, got %s", tt.expected, adapter.GetMethod())
			}
		})
	}
}

func TestEchoAdapter_GetPath(t *testing.T) {
	e := createTestEcho()
	var adapter *EchoAdapter

	e.GET("/api/users/:id", func(c echo.Context) error {
		adapter = NewEchoAdapter(c)
		return c.NoContent(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/api/users/123", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if adapter.GetPath() != "/api/users/123" {
		t.Errorf("Expected path '/api/users/123', got '%s'", adapter.GetPath())
	}
}

func TestEchoAdapter_GetURL(t *testing.T) {
	tests := []struct {
		name     string
		target   string
		expected string
	}{
		{
			name:     "with query params",
			target:   "/api/test?id=1",
			expected: "http://example.com/api/test?id=1",
		},
		{
			name:     "without query params",
			target:   "/api/test",
			expected: "http://example.com/api/test",
		},
		{
			name:     "with multiple query params",
			target:   "/api/test?id=1&foo=bar",
			expected: "http://example.com/api/test?id=1&foo=bar",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			e := createTestEcho()
			var adapter *EchoAdapter

			e.GET("/api/test", func(c echo.Context) error {
				adapter = NewEchoAdapter(c)
				return c.NoContent(http.StatusOK)
			})

			req := httptest.NewRequest("GET", tt.target, nil)
			req.Host = "example.com"
			w := httptest.NewRecorder()
			e.ServeHTTP(w, req)

			if adapter.GetURL() != tt.expected {
				t.Errorf("Expected URL '%s', got '%s'", tt.expected, adapter.GetURL())
			}
		})
	}
}

func TestEchoAdapter_GetAcceptHeader(t *testing.T) {
	e := createTestEcho()
	var adapter *EchoAdapter

	e.GET("/test", func(c echo.Context) error {
		adapter = NewEchoAdapter(c)
		return c.NoContent(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Accept", "text/html")

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if adapter.GetAcceptHeader() != "text/html" {
		t.Errorf("Expected Accept header 'text/html', got '%s'", adapter.GetAcceptHeader())
	}
}

func TestEchoAdapter_GetUserAgent(t *testing.T) {
	e := createTestEcho()
	var adapter *EchoAdapter

	e.GET("/test", func(c echo.Context) error {
		adapter = NewEchoAdapter(c)
		return c.NoContent(http.StatusOK)
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if adapter.GetUserAgent() != "Mozilla/5.0" {
		t.Errorf("Expected User-Agent 'Mozilla/5.0', got '%s'", adapter.GetUserAgent())
	}
}

// ============================================================================
// PaymentMiddleware Tests
// ============================================================================

func TestPaymentMiddleware_CallsNextWhenNoPaymentRequired(t *testing.T) {
	routes := x402http.RoutesConfig{
		"GET /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes, WithSyncFacilitatorOnStart(false)))

	nextCalled := false
	e.GET("/public", func(c echo.Context) error {
		nextCalled = true
		return c.JSON(http.StatusOK, map[string]interface{}{"message": "success"})
	})

	req := httptest.NewRequest("GET", "/public", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if !nextCalled {
		t.Error("Expected next() to be called for non-protected route")
	}
	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

func TestPaymentMiddleware_Returns402JSONForPaymentError(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"GET /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
			Description: "API access",
		},
	}

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	e.GET("/api", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "protected"})
	})

	req := httptest.NewRequest("GET", "/api", nil)
	req.Header.Set("Accept", "application/json")

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}

	if w.Header().Get("PAYMENT-REQUIRED") == "" {
		t.Error("Expected PAYMENT-REQUIRED header")
	}
}

func TestPaymentMiddleware_Returns402HTMLForBrowserRequest(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"*": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$5.00",
					Network: "eip155:1",
				},
			},
			Description: "Premium content",
		},
	}

	paywallConfig := &x402http.PaywallConfig{
		AppName: "Test App",
	}

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithPaywallConfig(paywallConfig),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	e.GET("/content", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "protected"})
	})

	req := httptest.NewRequest("GET", "/content", nil)
	req.Header.Set("Accept", "text/html")
	req.Header.Set("User-Agent", "Mozilla/5.0")

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}

	contentType := w.Header().Get("Content-Type")
	if !bytes.Contains([]byte(contentType), []byte("text/html")) {
		t.Errorf("Expected Content-Type to contain 'text/html', got '%s'", contentType)
	}

	body := w.Body.String()
	if !bytes.Contains([]byte(body), []byte("Payment Required")) {
		t.Error("Expected 'Payment Required' in HTML body")
	}
	if !bytes.Contains([]byte(body), []byte("Test App")) {
		t.Error("Expected app name in HTML body")
	}
}

func TestPaymentMiddleware_SettlesAndReturnsResponseForVerifiedPayment(t *testing.T) {
	settleCalled := false

	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			settleCalled = true
			return &x402.SettleResponse{
				Success:     true,
				Transaction: "0xtx",
				Network:     "eip155:1",
				Payer:       "0xpayer",
			}, nil
		},
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"POST /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	e.POST("/api", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	if !settleCalled {
		t.Error("Expected settlement to be called")
	}

	if w.Header().Get("PAYMENT-RESPONSE") == "" {
		t.Error("Expected PAYMENT-RESPONSE header")
	}
}

func TestPaymentMiddleware_SkipsSettlementWhenHandlerReturns400OrHigher(t *testing.T) {
	settleCalled := false

	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			settleCalled = true
			return &x402.SettleResponse{Success: true, Transaction: "0xtx"}, nil
		},
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"POST /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	e.POST("/api", func(c echo.Context) error {
		// Handler returns error status
		return c.JSON(http.StatusInternalServerError, map[string]interface{}{"error": "internal error"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("Expected status 500, got %d", w.Code)
	}

	if settleCalled {
		t.Error("Settlement should NOT be called when handler returns >= 400")
	}
}

func TestPaymentMiddleware_Returns402WhenSettlementFails(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success:     false,
				ErrorReason: "Insufficient funds",
			}, nil
		},
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"POST /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	e.POST("/api", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}

	// Empty body by default on settlement failure
	var response map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}
	if len(response) != 0 {
		t.Errorf("Expected empty body {}, got %v", response)
	}

	// PAYMENT-RESPONSE header must be included on settlement failure
	if w.Header().Get("PAYMENT-RESPONSE") == "" {
		t.Error("Expected PAYMENT-RESPONSE header on settlement failure")
	}
}

func TestPaymentMiddleware_CustomErrorHandler(t *testing.T) {
	customHandlerCalled := false

	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success:     false,
				ErrorReason: "Settlement rejected",
			}, nil
		},
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"POST /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	customErrorHandler := func(c echo.Context, err error) {
		customHandlerCalled = true
		// Reset committed state so we can write
		c.Response().Committed = false
		_ = c.JSON(http.StatusPaymentRequired, map[string]interface{}{
			"custom_error": err.Error(),
		})
	}

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithErrorHandler(customErrorHandler),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	e.POST("/api", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if !customHandlerCalled {
		t.Error("Expected custom error handler to be called")
	}

	var response map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil {
		t.Fatalf("Failed to parse response: %v", err)
	}

	if response["custom_error"] == nil {
		t.Error("Expected custom_error in response")
	}
}

func TestPaymentMiddleware_CustomSettlementHandler(t *testing.T) {
	settlementHandlerCalled := false
	var capturedSettleResponse *x402.SettleResponse

	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success:     true,
				Transaction: "0xtx123",
				Network:     "eip155:1",
				Payer:       "0xpayer",
			}, nil
		},
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"POST /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	customSettlementHandler := func(c echo.Context, settleResponse *x402.SettleResponse) {
		settlementHandlerCalled = true
		capturedSettleResponse = settleResponse
		// Add custom header
		c.Response().Header().Set("X-Transaction-ID", settleResponse.Transaction)
	}

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSettlementHandler(customSettlementHandler),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	e.POST("/api", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}

	if !settlementHandlerCalled {
		t.Error("Expected custom settlement handler to be called")
	}

	if capturedSettleResponse == nil {
		t.Fatal("Expected settle response to be captured")
	}

	if capturedSettleResponse.Transaction != "0xtx123" {
		t.Errorf("Expected transaction '0xtx123', got '%s'", capturedSettleResponse.Transaction)
	}

	if w.Header().Get("X-Transaction-ID") != "0xtx123" {
		t.Error("Expected custom X-Transaction-ID header")
	}
}

func TestPaymentMiddleware_WithTimeout(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"*": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	timeout := 10 * time.Second

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithTimeout(timeout),
		WithSyncFacilitatorOnStart(true),
	))

	e.GET("/test", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"message": "success"})
	})

	// Verify the middleware is created and requires payment
	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	// Route should require payment
	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}
}

// ============================================================================
// PaymentMiddlewareFromHTTPServer Tests
// ============================================================================

func TestPaymentMiddlewareFromHTTPServer_Returns402ForProtectedRoute(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	routes := x402http.RoutesConfig{
		"GET /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	// Build the resource server externally
	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockClient),
	)
	resourceServer.Register("eip155:1", &mockSchemeServer{scheme: "exact"})

	// Wrap with HTTP server
	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer)

	// Use PaymentMiddlewareFromHTTPServer
	e := createTestEcho()
	e.Use(PaymentMiddlewareFromHTTPServer(httpServer, WithTimeout(5*time.Second)))

	e.GET("/api", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "protected"})
	})

	req := httptest.NewRequest("GET", "/api", nil)
	req.Header.Set("Accept", "application/json")
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}
}

func TestPaymentMiddlewareFromHTTPServer_PassesThroughNonProtectedRoute(t *testing.T) {
	routes := x402http.RoutesConfig{
		"GET /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	resourceServer := x402.Newx402ResourceServer()
	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer)

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromHTTPServer(httpServer, WithSyncFacilitatorOnStart(false)))

	nextCalled := false
	e.GET("/public", func(c echo.Context) error {
		nextCalled = true
		return c.JSON(http.StatusOK, map[string]interface{}{"message": "public"})
	})

	req := httptest.NewRequest("GET", "/public", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if !nextCalled {
		t.Error("Expected next() to be called for non-protected route")
	}
	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

func TestPaymentMiddlewareFromHTTPServer_HookGrantsAccess(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	routes := x402http.RoutesConfig{
		"GET /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockClient),
	)
	resourceServer.Register("eip155:1", &mockSchemeServer{scheme: "exact"})

	// Register a hook that grants free access
	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer).
		OnProtectedRequest(func(ctx context.Context, reqCtx x402http.HTTPRequestContext, routeConfig x402http.RouteConfig) (*x402http.ProtectedRequestHookResult, error) {
			return &x402http.ProtectedRequestHookResult{GrantAccess: true}, nil
		})

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromHTTPServer(httpServer, WithTimeout(5*time.Second)))

	nextCalled := false
	e.GET("/api", func(c echo.Context) error {
		nextCalled = true
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "free-access"})
	})

	// Request without payment header - hook should grant access
	req := httptest.NewRequest("GET", "/api", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200 (hook granted access), got %d. Body: %s", w.Code, w.Body.String())
	}
	if !nextCalled {
		t.Error("Expected next handler to be called when hook grants access")
	}
}

func TestPaymentMiddlewareFromHTTPServer_HookAbortsRequest(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	routes := x402http.RoutesConfig{
		"GET /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockClient),
	)
	resourceServer.Register("eip155:1", &mockSchemeServer{scheme: "exact"})

	// Register a hook that aborts the request
	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer).
		OnProtectedRequest(func(ctx context.Context, reqCtx x402http.HTTPRequestContext, routeConfig x402http.RouteConfig) (*x402http.ProtectedRequestHookResult, error) {
			return &x402http.ProtectedRequestHookResult{Abort: true, Reason: "IP blocked"}, nil
		})

	e := createTestEcho()
	e.Use(PaymentMiddlewareFromHTTPServer(httpServer, WithTimeout(5*time.Second)))

	e.GET("/api", func(c echo.Context) error {
		t.Error("Handler should not be called when hook aborts")
		return nil
	})

	req := httptest.NewRequest("GET", "/api", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusForbidden {
		t.Errorf("Expected status 403 (hook aborted), got %d", w.Code)
	}
}

// ============================================================================
// X402Payment (Builder Pattern) Tests
// ============================================================================

func TestX402Payment_CreatesWorkingMiddleware(t *testing.T) {
	mockClient := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"GET /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	e := createTestEcho()
	e.Use(X402Payment(Config{
		Routes:      routes,
		Facilitator: mockClient,
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                5 * time.Second,
	}))

	e.GET("/api", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"data": "protected"})
	})

	// Test non-protected route passes through
	e.GET("/public", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"message": "public"})
	})

	req := httptest.NewRequest("GET", "/public", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200 for public route, got %d", w.Code)
	}

	// Test protected route requires payment
	req = httptest.NewRequest("GET", "/api", nil)
	w = httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402 for protected route, got %d", w.Code)
	}
}

func TestX402Payment_RegistersMultipleFacilitators(t *testing.T) {
	mockClient1 := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}
	mockClient2 := &mockFacilitatorClient{
		supportedFunc: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"*": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	// This should not panic and properly register multiple facilitators
	e := createTestEcho()
	e.Use(X402Payment(Config{
		Routes:       routes,
		Facilitators: []x402.FacilitatorClient{mockClient1, mockClient2},
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer},
		},
		SyncFacilitatorOnStart: true,
	}))

	e.GET("/test", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"message": "success"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}
}

func TestX402Payment_RegistersMultipleSchemes(t *testing.T) {
	mockServer1 := &mockSchemeServer{scheme: "exact"}
	mockServer2 := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"*": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	// This should not panic
	e := createTestEcho()
	e.Use(X402Payment(Config{
		Routes: routes,
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer1},
			{Network: "eip155:8453", Server: mockServer2},
		},
		SyncFacilitatorOnStart: false,
	}))

	e.GET("/test", func(c echo.Context) error {
		return c.JSON(http.StatusOK, map[string]interface{}{"message": "success"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	e.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}
}

// ============================================================================
// responseCapture Tests
// ============================================================================

func TestResponseCapture_CapturesStatusCode(t *testing.T) {
	capture := &responseCapture{
		ResponseWriter: httptest.NewRecorder(),
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}

	capture.WriteHeader(http.StatusCreated)

	if capture.statusCode != http.StatusCreated {
		t.Errorf("Expected status 201, got %d", capture.statusCode)
	}
}

func TestResponseCapture_CapturesBody(t *testing.T) {
	capture := &responseCapture{
		ResponseWriter: httptest.NewRecorder(),
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}

	data := []byte(`{"message":"test"}`)
	n, err := capture.Write(data)

	if err != nil {
		t.Fatalf("Write failed: %v", err)
	}
	if n != len(data) {
		t.Errorf("Expected to write %d bytes, wrote %d", len(data), n)
	}
	if capture.body.String() != `{"message":"test"}` {
		t.Errorf("Expected body '%s', got '%s'", `{"message":"test"}`, capture.body.String())
	}
}

func TestResponseCapture_WriteString(t *testing.T) {
	capture := &responseCapture{
		ResponseWriter: httptest.NewRecorder(),
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}

	n, err := capture.WriteString("hello world")

	if err != nil {
		t.Fatalf("WriteString failed: %v", err)
	}
	if n != 11 {
		t.Errorf("Expected to write 11 bytes, wrote %d", n)
	}
	if capture.body.String() != "hello world" {
		t.Errorf("Expected body 'hello world', got '%s'", capture.body.String())
	}
}

func TestResponseCapture_WriteHeaderOnlyOnce(t *testing.T) {
	capture := &responseCapture{
		ResponseWriter: httptest.NewRecorder(),
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}

	capture.WriteHeader(http.StatusCreated)
	capture.WriteHeader(http.StatusAccepted) // Should be ignored

	if capture.statusCode != http.StatusCreated {
		t.Errorf("Expected status 201 (first call), got %d", capture.statusCode)
	}
}
