package nethttp

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	"github.com/coinbase/x402/go/types"
)

// ============================================================================
// Mock Implementations
// ============================================================================

// mockSchemeServer implements x402.SchemeNetworkServer for testing.
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

// mockFacilitatorClient implements x402.FacilitatorClient for testing.
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

// createPaymentHeader creates a base64-encoded payment header for testing.
//
//nolint:unparam // payTo is always "0xtest" in current tests but keeping param for flexibility
func createPaymentHeader(payTo string) string {
	payload := x402.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]any{"sig": "test"},
		Accepted: x402.PaymentRequirements{
			Scheme:            "exact",
			Network:           "eip155:1",
			Asset:             "USDC",
			Amount:            "1000000",
			PayTo:             payTo,
			MaxTimeoutSeconds: 300,
			Extra: map[string]any{
				"resourceUrl": "http://example.com/api",
			},
		},
	}

	payloadJSON, _ := json.Marshal(payload)
	return base64.StdEncoding.EncodeToString(payloadJSON)
}

// defaultSupportedFunc returns a standard supported response function for tests.
func defaultSupportedFunc() func(ctx context.Context) (x402.SupportedResponse, error) {
	return func(ctx context.Context) (x402.SupportedResponse, error) {
		return x402.SupportedResponse{
			Kinds: []x402.SupportedKind{
				{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
			},
			Extensions: []string{},
			Signers:    make(map[string][]string),
		}, nil
	}
}

// ============================================================================
// NetHTTPAdapter Tests
// ============================================================================

func TestNetHTTPAdapter_GetHeader(t *testing.T) {
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("X-Custom-Header", "test-value")
	req.Header.Set("payment-signature", "sig-data")

	adapter := NewNetHTTPAdapter(req)

	if adapter.GetHeader("X-Custom-Header") != "test-value" {
		t.Error("Expected X-Custom-Header to be 'test-value'")
	}

	if adapter.GetHeader("payment-signature") != "sig-data" {
		t.Error("Expected payment-signature header")
	}
}

func TestNetHTTPAdapter_GetMethod(t *testing.T) {
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
			req := httptest.NewRequest(tt.method, "/test", nil)
			adapter := NewNetHTTPAdapter(req)

			if adapter.GetMethod() != tt.expected {
				t.Errorf("Expected method %s, got %s", tt.expected, adapter.GetMethod())
			}
		})
	}
}

func TestNetHTTPAdapter_GetPath(t *testing.T) {
	req := httptest.NewRequest("GET", "/api/users/123", nil)
	adapter := NewNetHTTPAdapter(req)

	if adapter.GetPath() != "/api/users/123" {
		t.Errorf("Expected path '/api/users/123', got '%s'", adapter.GetPath())
	}
}

func TestNetHTTPAdapter_GetURL(t *testing.T) {
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
			req := httptest.NewRequest("GET", tt.target, nil)
			req.Host = "example.com"
			adapter := NewNetHTTPAdapter(req)

			if adapter.GetURL() != tt.expected {
				t.Errorf("Expected URL '%s', got '%s'", tt.expected, adapter.GetURL())
			}
		})
	}
}

func TestNetHTTPAdapter_GetAcceptHeader(t *testing.T) {
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Accept", "text/html")

	adapter := NewNetHTTPAdapter(req)

	if adapter.GetAcceptHeader() != "text/html" {
		t.Errorf("Expected Accept header 'text/html', got '%s'", adapter.GetAcceptHeader())
	}
}

func TestNetHTTPAdapter_GetUserAgent(t *testing.T) {
	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")

	adapter := NewNetHTTPAdapter(req)

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

	nextCalled := false
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		nextCalled = true
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "success"})
	})

	middleware := PaymentMiddlewareFromConfig(routes, WithSyncFacilitatorOnStart(false))
	wrapped := middleware(handler)

	req := httptest.NewRequest("GET", "/public", nil)
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if !nextCalled {
		t.Error("Expected next handler to be called for non-protected route")
	}
	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d", w.Code)
	}
}

func TestPaymentMiddleware_Returns402JSONForPaymentError(t *testing.T) {
	mockClient := &mockFacilitatorClient{supportedFunc: defaultSupportedFunc()}
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("GET", "/api", nil)
	req.Header.Set("Accept", "application/json")

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}

	if w.Header().Get("PAYMENT-REQUIRED") == "" {
		t.Error("Expected PAYMENT-REQUIRED header")
	}
}

func TestPaymentMiddleware_Returns402HTMLForBrowserRequest(t *testing.T) {
	mockClient := &mockFacilitatorClient{supportedFunc: defaultSupportedFunc()}
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithPaywallConfig(paywallConfig),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("GET", "/content", nil)
	req.Header.Set("Accept", "text/html")
	req.Header.Set("User-Agent", "Mozilla/5.0")

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

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
		supportedFunc: defaultSupportedFunc(),
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected-data"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

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
		supportedFunc: defaultSupportedFunc(),
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "internal error"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

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
		supportedFunc: defaultSupportedFunc(),
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected-data"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}

	// Empty body by default on settlement failure
	var response map[string]any
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
		supportedFunc: defaultSupportedFunc(),
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

	customErrorHandler := func(w http.ResponseWriter, r *http.Request, err error) {
		customHandlerCalled = true
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusPaymentRequired)
		_ = json.NewEncoder(w).Encode(map[string]string{
			"custom_error": err.Error(),
		})
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected-data"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithErrorHandler(customErrorHandler),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if !customHandlerCalled {
		t.Error("Expected custom error handler to be called")
	}

	var response map[string]any
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
		supportedFunc: defaultSupportedFunc(),
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

	customSettlementHandler := func(w http.ResponseWriter, r *http.Request, settleResponse *x402.SettleResponse) {
		settlementHandlerCalled = true
		capturedSettleResponse = settleResponse
		w.Header().Set("X-Transaction-ID", settleResponse.Transaction)
	}

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected-data"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSettlementHandler(customSettlementHandler),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

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
	mockClient := &mockFacilitatorClient{supportedFunc: defaultSupportedFunc()}
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "success"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithTimeout(timeout),
		WithSyncFacilitatorOnStart(true),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}
}

// ============================================================================
// X402Payment (Builder Pattern) Tests
// ============================================================================

func TestX402Payment_CreatesWorkingMiddleware(t *testing.T) {
	mockClient := &mockFacilitatorClient{supportedFunc: defaultSupportedFunc()}
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

	protectedHandler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected"})
	})

	middleware := X402Payment(Config{
		Routes:      routes,
		Facilitator: mockClient,
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                5 * time.Second,
	})
	wrapped := middleware(protectedHandler)

	// Test non-protected route passes through
	req := httptest.NewRequest("GET", "/public", nil)
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200 for public route, got %d", w.Code)
	}

	// Test protected route requires payment
	req = httptest.NewRequest("GET", "/api", nil)
	w = httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402 for protected route, got %d", w.Code)
	}
}

func TestX402Payment_RegistersMultipleFacilitators(t *testing.T) {
	mockClient1 := &mockFacilitatorClient{supportedFunc: defaultSupportedFunc()}
	mockClient2 := &mockFacilitatorClient{supportedFunc: defaultSupportedFunc()}
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "success"})
	})

	middleware := X402Payment(Config{
		Routes:       routes,
		Facilitators: []x402.FacilitatorClient{mockClient1, mockClient2},
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer},
		},
		SyncFacilitatorOnStart: true,
	})
	wrapped := middleware(handler)

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"message": "success"})
	})

	middleware := X402Payment(Config{
		Routes: routes,
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer1},
			{Network: "eip155:8453", Server: mockServer2},
		},
		SyncFacilitatorOnStart: false,
	})
	wrapped := middleware(handler)

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}
}

// ============================================================================
// Context Helper Tests
// ============================================================================

func TestPayloadFromContext_ReturnsPayload(t *testing.T) {
	payload := &types.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]any{"sig": "test"},
	}

	ctx := withPayload(context.Background(), payload)
	got, ok := PayloadFromContext(ctx)

	if !ok {
		t.Fatal("Expected payload to be found in context")
	}
	if got.X402Version != 2 {
		t.Errorf("Expected X402Version 2, got %d", got.X402Version)
	}
}

func TestPayloadFromContext_ReturnsFalseWhenMissing(t *testing.T) {
	_, ok := PayloadFromContext(context.Background())
	if ok {
		t.Error("Expected payload not to be found in empty context")
	}
}

func TestRequirementsFromContext_ReturnsRequirements(t *testing.T) {
	reqs := &types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
	}

	ctx := withRequirements(context.Background(), reqs)
	got, ok := RequirementsFromContext(ctx)

	if !ok {
		t.Fatal("Expected requirements to be found in context")
	}
	if got.Scheme != "exact" {
		t.Errorf("Expected scheme 'exact', got '%s'", got.Scheme)
	}
}

func TestRequirementsFromContext_ReturnsFalseWhenMissing(t *testing.T) {
	_, ok := RequirementsFromContext(context.Background())
	if ok {
		t.Error("Expected requirements not to be found in empty context")
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

func TestPaymentMiddleware_PayloadAvailableInDownstreamHandler(t *testing.T) {
	var capturedPayload *types.PaymentPayload

	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success:     true,
				Transaction: "0xtx",
				Network:     "eip155:1",
				Payer:       "0xpayer",
			}, nil
		},
		supportedFunc: defaultSupportedFunc(),
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

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		payload, ok := PayloadFromContext(r.Context())
		if ok {
			capturedPayload = payload
		}
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"ok":true}`))
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	if capturedPayload == nil {
		t.Fatal("Expected payment payload to be available in downstream handler context")
	}

	if capturedPayload.X402Version != 2 {
		t.Errorf("Expected X402Version 2, got %d", capturedPayload.X402Version)
	}
}

// ============================================================================
// PaymentMiddlewareFromHTTPServer Tests
// ============================================================================

func TestPaymentMiddlewareFromHTTPServer_Returns402ForProtectedRoute(t *testing.T) {
	mockClient := &mockFacilitatorClient{supportedFunc: defaultSupportedFunc()}
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

	// Create resource server and wrap as HTTPServer (same pattern as user would)
	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockClient),
	)
	resourceServer.Register("eip155:1", mockServer)

	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected"})
	})

	middleware := PaymentMiddlewareFromHTTPServer(httpServer,
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	// Protected route should require payment
	req := httptest.NewRequest("GET", "/api", nil)
	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402 for protected route, got %d", w.Code)
	}

	// Non-protected route should pass through
	req = httptest.NewRequest("GET", "/public", nil)
	w = httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200 for public route, got %d", w.Code)
	}
}

// ============================================================================
// Settlement Override Round-Trip Tests
// ============================================================================

// TestPaymentMiddleware_SettlementOverrideViaHeader verifies the full path:
// SetSettlementOverrides (handler) → responseCapture.Header() →
// HTTPTransportContext.ResponseHeaders → ProcessSettlement → facilitator.
//
// This test would have caught the header canonicalization bug (issue #1):
// net/http stores headers as Title-Case ("Settlement-Overrides") but the
// old code used a raw map lookup with the lowercase key ("settlement-overrides"),
// silently missing the override every time.
func TestPaymentMiddleware_SettlementOverrideViaHeader(t *testing.T) {
	var capturedRequirementsBytes []byte

	mockClient := &mockFacilitatorClient{
		verifyFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{IsValid: true, Payer: "0xpayer"}, nil
		},
		settleFunc: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			capturedRequirementsBytes = requirementsBytes
			return &x402.SettleResponse{
				Success:     true,
				Transaction: "0xtx",
				Network:     "eip155:1",
				Payer:       "0xpayer",
			}, nil
		},
		supportedFunc: defaultSupportedFunc(),
	}

	mockServer := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"POST /api": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00", // mockSchemeServer.ParsePrice returns Amount "1000000"
					Network: "eip155:1",
				},
			},
		},
	}

	// Handler calls SetSettlementOverrides to request partial settlement of 500.
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		SetSettlementOverrides(w, &x402.SettlementOverrides{Amount: "500"})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "ok"})
	})

	middleware := PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	if w.Header().Get("PAYMENT-RESPONSE") == "" {
		t.Error("Expected PAYMENT-RESPONSE header (settlement must succeed)")
	}

	// The settlement-overrides header must be stripped from the client response.
	// If the canonicalization bug were present, ProcessSettlement would fail to find
	// and delete the canonical "Settlement-Overrides" key, and the header would leak.
	if w.Header().Get(x402http.SettlementOverridesHeader) != "" {
		t.Error("settlement-overrides header must be stripped from the client response by the middleware")
	}

	// Verify the overridden amount reached the facilitator.
	if capturedRequirementsBytes == nil {
		t.Fatal("settle was never called; payment was not processed")
	}
	var settledReqs struct {
		Amount string `json:"amount"`
	}
	if err := json.Unmarshal(capturedRequirementsBytes, &settledReqs); err != nil {
		t.Fatalf("failed to unmarshal captured requirements: %v", err)
	}
	if settledReqs.Amount != "500" {
		t.Errorf("expected settle to be called with amount \"500\" (override), got %q", settledReqs.Amount)
	}
}

func TestPaymentMiddlewareFromHTTPServer_SettlesVerifiedPayment(t *testing.T) {
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
		supportedFunc: defaultSupportedFunc(),
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

	resourceServer := x402.Newx402ResourceServer(
		x402.WithFacilitatorClient(mockClient),
	)
	resourceServer.Register("eip155:1", mockServer)

	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer)

	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_ = json.NewEncoder(w).Encode(map[string]string{"data": "protected-data"})
	})

	middleware := PaymentMiddlewareFromHTTPServer(httpServer,
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	)
	wrapped := middleware(handler)

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	wrapped.ServeHTTP(w, req)

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
