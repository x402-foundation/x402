package gin

import (
	"bufio"
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/types"
)

// ============================================================================
// Test Setup
// ============================================================================

func init() {
	gin.SetMode(gin.TestMode)
}

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

// createTestRouter creates a Gin router for testing
func createTestRouter() *gin.Engine {
	router := gin.New()
	return router
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
// GinAdapter Tests
// ============================================================================

func TestGinAdapter_GetHeader(t *testing.T) {
	router := createTestRouter()
	var adapter *GinAdapter

	router.GET("/test", func(c *gin.Context) {
		adapter = NewGinAdapter(c)
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("X-Custom-Header", "test-value")
	req.Header.Set("payment-signature", "sig-data")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if adapter.GetHeader("X-Custom-Header") != "test-value" {
		t.Error("Expected X-Custom-Header to be 'test-value'")
	}

	if adapter.GetHeader("payment-signature") != "sig-data" {
		t.Error("Expected payment-signature header")
	}
}

func TestGinAdapter_GetMethod(t *testing.T) {
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
			router := createTestRouter()
			var adapter *GinAdapter

			router.Handle(tt.method, "/test", func(c *gin.Context) {
				adapter = NewGinAdapter(c)
			})

			req := httptest.NewRequest(tt.method, "/test", nil)
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if adapter.GetMethod() != tt.expected {
				t.Errorf("Expected method %s, got %s", tt.expected, adapter.GetMethod())
			}
		})
	}
}

func TestGinAdapter_GetPath(t *testing.T) {
	router := createTestRouter()
	var adapter *GinAdapter

	router.GET("/api/users/:id", func(c *gin.Context) {
		adapter = NewGinAdapter(c)
	})

	req := httptest.NewRequest("GET", "/api/users/123", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if adapter.GetPath() != "/api/users/123" {
		t.Errorf("Expected path '/api/users/123', got '%s'", adapter.GetPath())
	}
}

func TestGinAdapter_GetURL(t *testing.T) {
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
			router := createTestRouter()
			var adapter *GinAdapter

			router.GET("/api/test", func(c *gin.Context) {
				adapter = NewGinAdapter(c)
			})

			req := httptest.NewRequest("GET", tt.target, nil)
			req.Host = "example.com"
			w := httptest.NewRecorder()
			router.ServeHTTP(w, req)

			if adapter.GetURL() != tt.expected {
				t.Errorf("Expected URL '%s', got '%s'", tt.expected, adapter.GetURL())
			}
		})
	}
}

func TestGinAdapter_GetAcceptHeader(t *testing.T) {
	router := createTestRouter()
	var adapter *GinAdapter

	router.GET("/test", func(c *gin.Context) {
		adapter = NewGinAdapter(c)
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("Accept", "text/html")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if adapter.GetAcceptHeader() != "text/html" {
		t.Errorf("Expected Accept header 'text/html', got '%s'", adapter.GetAcceptHeader())
	}
}

func TestGinAdapter_GetUserAgent(t *testing.T) {
	router := createTestRouter()
	var adapter *GinAdapter

	router.GET("/test", func(c *gin.Context) {
		adapter = NewGinAdapter(c)
	})

	req := httptest.NewRequest("GET", "/test", nil)
	req.Header.Set("User-Agent", "Mozilla/5.0")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes, WithSyncFacilitatorOnStart(false)))

	nextCalled := false
	router.GET("/public", func(c *gin.Context) {
		nextCalled = true
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	})

	req := httptest.NewRequest("GET", "/public", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	router.GET("/api", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "protected"})
	})

	req := httptest.NewRequest("GET", "/api", nil)
	req.Header.Set("Accept", "application/json")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithPaywallConfig(paywallConfig),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	router.GET("/content", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "protected"})
	})

	req := httptest.NewRequest("GET", "/content", nil)
	req.Header.Set("Accept", "text/html")
	req.Header.Set("User-Agent", "Mozilla/5.0")

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	router.POST("/api", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	router.POST("/api", func(c *gin.Context) {
		// Handler returns error
		c.JSON(http.StatusInternalServerError, gin.H{"error": "internal error"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	router.POST("/api", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	// AYMENT-RESPONSE header must be included on settlement failure
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

	customErrorHandler := func(c *gin.Context, err error) {
		customHandlerCalled = true
		c.JSON(http.StatusPaymentRequired, gin.H{
			"custom_error": err.Error(),
		})
	}

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithErrorHandler(customErrorHandler),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	router.POST("/api", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	// PAYMENT-RESPONSE header must be set even when using custom error handler
	if w.Header().Get("PAYMENT-RESPONSE") == "" {
		t.Error("Expected PAYMENT-RESPONSE header when using custom error handler")
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

	customSettlementHandler := func(c *gin.Context, settleResponse *x402.SettleResponse) {
		settlementHandlerCalled = true
		capturedSettleResponse = settleResponse
		// Add custom header
		c.Header("X-Transaction-ID", settleResponse.Transaction)
	}

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithSettlementHandler(customSettlementHandler),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	router.POST("/api", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "protected-data"})
	})

	req := httptest.NewRequest("POST", "/api", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockServer),
		WithTimeout(timeout),
		WithSyncFacilitatorOnStart(true),
	))

	router.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	})

	// Verify the middleware is created and requires payment
	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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
	router := createTestRouter()
	router.Use(PaymentMiddlewareFromHTTPServer(httpServer, WithTimeout(5*time.Second)))

	router.GET("/api", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "protected"})
	})

	req := httptest.NewRequest("GET", "/api", nil)
	req.Header.Set("Accept", "application/json")
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromHTTPServer(httpServer, WithSyncFacilitatorOnStart(false)))

	nextCalled := false
	router.GET("/public", func(c *gin.Context) {
		nextCalled = true
		c.JSON(http.StatusOK, gin.H{"message": "public"})
	})

	req := httptest.NewRequest("GET", "/public", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromHTTPServer(httpServer, WithTimeout(5*time.Second)))

	nextCalled := false
	router.GET("/api", func(c *gin.Context) {
		nextCalled = true
		c.JSON(http.StatusOK, gin.H{"data": "free-access"})
	})

	// Request without payment header - hook should grant access
	req := httptest.NewRequest("GET", "/api", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromHTTPServer(httpServer, WithTimeout(5*time.Second)))

	router.GET("/api", func(c *gin.Context) {
		t.Error("Handler should not be called when hook aborts")
	})

	req := httptest.NewRequest("GET", "/api", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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

	router := createTestRouter()
	router.Use(X402Payment(Config{
		Routes:      routes,
		Facilitator: mockClient,
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer},
		},
		SyncFacilitatorOnStart: true,
		Timeout:                5 * time.Second,
	}))

	router.GET("/api", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"data": "protected"})
	})

	// Test non-protected route passes through
	router.GET("/public", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"message": "public"})
	})

	req := httptest.NewRequest("GET", "/public", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200 for public route, got %d", w.Code)
	}

	// Test protected route requires payment
	req = httptest.NewRequest("GET", "/api", nil)
	w = httptest.NewRecorder()
	router.ServeHTTP(w, req)

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
	router := createTestRouter()
	router.Use(X402Payment(Config{
		Routes:       routes,
		Facilitators: []x402.FacilitatorClient{mockClient1, mockClient2},
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer},
		},
		SyncFacilitatorOnStart: true,
	}))

	router.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

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
	router := createTestRouter()
	router.Use(X402Payment(Config{
		Routes: routes,
		Schemes: []SchemeConfig{
			{Network: "eip155:1", Server: mockServer1},
			{Network: "eip155:8453", Server: mockServer2},
		},
		SyncFacilitatorOnStart: false,
	}))

	router.GET("/test", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"message": "success"})
	})

	req := httptest.NewRequest("GET", "/test", nil)
	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusPaymentRequired {
		t.Errorf("Expected status 402, got %d", w.Code)
	}
}

// ============================================================================
// responseCapture Tests
// ============================================================================

func TestResponseCapture_CapturesStatusCode(t *testing.T) {
	capture := &responseCapture{
		ResponseWriter: &mockGinResponseWriter{
			ResponseRecorder: httptest.NewRecorder(),
		},
		body:       &bytes.Buffer{},
		statusCode: http.StatusOK,
	}

	capture.WriteHeader(http.StatusCreated)

	if capture.statusCode != http.StatusCreated {
		t.Errorf("Expected status 201, got %d", capture.statusCode)
	}
}

func TestResponseCapture_CapturesBody(t *testing.T) {
	capture := &responseCapture{
		ResponseWriter: &mockGinResponseWriter{
			ResponseRecorder: httptest.NewRecorder(),
		},
		body:       &bytes.Buffer{},
		statusCode: http.StatusOK,
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
		ResponseWriter: &mockGinResponseWriter{
			ResponseRecorder: httptest.NewRecorder(),
		},
		body:       &bytes.Buffer{},
		statusCode: http.StatusOK,
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
		ResponseWriter: &mockGinResponseWriter{
			ResponseRecorder: httptest.NewRecorder(),
		},
		body:       &bytes.Buffer{},
		statusCode: http.StatusOK,
	}

	capture.WriteHeader(http.StatusCreated)
	capture.WriteHeader(http.StatusAccepted) // Should be ignored

	if capture.statusCode != http.StatusCreated {
		t.Errorf("Expected status 201 (first call), got %d", capture.statusCode)
	}
}

// mockGinResponseWriter implements gin.ResponseWriter for testing.
// It tracks Flush and WriteHeaderNow calls so tests can verify that
// responseCapture prevents them from reaching the embedded writer.
type mockGinResponseWriter struct {
	*httptest.ResponseRecorder
	status            int
	size              int
	flushCount        int
	writeHeaderNowCnt int
}

func (m *mockGinResponseWriter) Status() int {
	return m.status
}

func (m *mockGinResponseWriter) Size() int {
	return m.size
}

func (m *mockGinResponseWriter) Written() bool {
	return m.size > 0
}

func (m *mockGinResponseWriter) WriteHeader(code int) {
	m.status = code
	m.ResponseRecorder.WriteHeader(code)
}

func (m *mockGinResponseWriter) WriteHeaderNow() {
	m.writeHeaderNowCnt++
}

func (m *mockGinResponseWriter) Write(data []byte) (int, error) {
	n, err := m.ResponseRecorder.Write(data)
	m.size += n
	return n, err
}

func (m *mockGinResponseWriter) WriteString(s string) (int, error) {
	return m.Write([]byte(s))
}

func (m *mockGinResponseWriter) Pusher() http.Pusher {
	return nil
}

func (m *mockGinResponseWriter) CloseNotify() <-chan bool {
	return make(chan bool)
}

func (m *mockGinResponseWriter) Flush() {
	m.flushCount++
	m.ResponseRecorder.Flush()
}

func (m *mockGinResponseWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, nil
}

// ============================================================================
// responseCapture: Flush / WriteHeaderNow / Status / Size / Written tests
// ============================================================================

func TestResponseCapture_FlushIsNoOp(t *testing.T) {
	mock := &mockGinResponseWriter{
		ResponseRecorder: httptest.NewRecorder(),
	}
	capture := &responseCapture{
		ResponseWriter: mock,
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}

	capture.Write([]byte("some data"))
	capture.Flush()
	capture.Flush()

	if mock.flushCount != 0 {
		t.Errorf("Expected Flush to NOT reach embedded writer, got %d calls", mock.flushCount)
	}
	if capture.body.String() != "some data" {
		t.Errorf("Expected buffered body 'some data', got '%s'", capture.body.String())
	}
}

func TestResponseCapture_WriteHeaderNowIsNoOp(t *testing.T) {
	mock := &mockGinResponseWriter{
		ResponseRecorder: httptest.NewRecorder(),
	}
	capture := &responseCapture{
		ResponseWriter: mock,
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}

	capture.WriteHeaderNow()
	capture.WriteHeaderNow()

	if mock.writeHeaderNowCnt != 0 {
		t.Errorf("Expected WriteHeaderNow to NOT reach embedded writer, got %d calls", mock.writeHeaderNowCnt)
	}
}

func TestResponseCapture_StatusSizeWritten(t *testing.T) {
	mock := &mockGinResponseWriter{
		ResponseRecorder: httptest.NewRecorder(),
	}
	capture := &responseCapture{
		ResponseWriter: mock,
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}

	if capture.Status() != http.StatusOK {
		t.Errorf("Expected initial status 200, got %d", capture.Status())
	}
	if capture.Size() != 0 {
		t.Errorf("Expected initial size 0, got %d", capture.Size())
	}
	if capture.Written() {
		t.Error("Expected Written() == false before any write")
	}

	capture.WriteHeader(http.StatusCreated)
	capture.Write([]byte("hello"))

	if capture.Status() != http.StatusCreated {
		t.Errorf("Expected status 201, got %d", capture.Status())
	}
	if capture.Size() != 5 {
		t.Errorf("Expected size 5, got %d", capture.Size())
	}
	if !capture.Written() {
		t.Error("Expected Written() == true after WriteHeader")
	}

	if mock.status != 0 {
		t.Errorf("Expected embedded writer status unchanged (0), got %d", mock.status)
	}
	if mock.size != 0 {
		t.Errorf("Expected embedded writer size unchanged (0), got %d", mock.size)
	}
}

// ============================================================================
// Streaming integration test
// ============================================================================

func TestPaymentMiddleware_StreamingDoesNotLeakHeaders(t *testing.T) {
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

	mockScheme := &mockSchemeServer{scheme: "exact"}

	routes := x402http.RoutesConfig{
		"GET /stream": x402http.RouteConfig{
			Accepts: x402http.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
			MimeType: "text/event-stream",
		},
	}

	router := createTestRouter()
	router.Use(PaymentMiddlewareFromConfig(routes,
		WithFacilitatorClient(mockClient),
		WithScheme("eip155:1", mockScheme),
		WithSyncFacilitatorOnStart(true),
		WithTimeout(5*time.Second),
	))

	router.GET("/stream", func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		c.Header("Cache-Control", "no-cache")
		for i := 0; i < 3; i++ {
			chunk := fmt.Sprintf("data: {\"n\":%d}\n\n", i)
			_, _ = c.Writer.Write([]byte(chunk))
			if f, ok := c.Writer.(http.Flusher); ok {
				f.Flush()
			}
		}
	})

	req := httptest.NewRequest("GET", "/stream", nil)
	req.Header.Set("PAYMENT-SIGNATURE", createPaymentHeader("0xtest"))
	req.Host = "example.com"

	w := httptest.NewRecorder()
	router.ServeHTTP(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("Expected status 200, got %d. Body: %s", w.Code, w.Body.String())
	}

	if !settleCalled {
		t.Error("Expected settlement to be called for streaming response")
	}

	paymentResponse := w.Header().Get("PAYMENT-RESPONSE")
	if paymentResponse == "" {
		t.Error("Expected PAYMENT-RESPONSE header in final response; streaming Flush must not commit headers early")
	}

	body := w.Body.String()
	for i := 0; i < 3; i++ {
		expected := fmt.Sprintf("data: {\"n\":%d}\n\n", i)
		if !bytes.Contains([]byte(body), []byte(expected)) {
			t.Errorf("Expected body to contain chunk %d (%q), got: %s", i, expected, body)
		}
	}
}
