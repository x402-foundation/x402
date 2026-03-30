package http

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"net/http"
	"strings"
	"testing"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/types"
)

// Mock HTTP adapter for testing
type mockHTTPAdapter struct {
	headers map[string]string
	method  string
	path    string
	url     string
	accept  string
	agent   string
}

func (m *mockHTTPAdapter) GetHeader(name string) string {
	if m.headers == nil {
		return ""
	}
	return m.headers[name]
}

func (m *mockHTTPAdapter) GetMethod() string {
	return m.method
}

func (m *mockHTTPAdapter) GetPath() string {
	return m.path
}

func (m *mockHTTPAdapter) GetURL() string {
	return m.url
}

func (m *mockHTTPAdapter) GetAcceptHeader() string {
	return m.accept
}

func (m *mockHTTPAdapter) GetUserAgent() string {
	return m.agent
}

func TestNewx402HTTPResourceServer(t *testing.T) {
	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	server := Newx402HTTPResourceServer(routes)
	if server == nil {
		t.Fatal("Expected server to be created")
	}
	if server.X402ResourceServer == nil {
		t.Fatal("Expected embedded resource server")
	}
	if len(server.compiledRoutes) != 1 {
		t.Fatal("Expected 1 compiled route")
	}
}

func TestProcessHTTPRequestNoPaymentRequired(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	server := Newx402HTTPResourceServer(routes)

	// Request to non-protected path
	adapter := &mockHTTPAdapter{
		method: "GET",
		path:   "/public",
		url:    "http://example.com/public",
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/public",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

	if result.Type != ResultNoPaymentRequired {
		t.Errorf("Expected no payment required, got %s", result.Type)
	}
}

func TestProcessHTTPRequestPaymentRequired(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{
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

	// Create mock scheme server
	mockServer := &mockSchemeServer{
		scheme: "exact",
	}

	// Create mock facilitator client
	mockClient := &mockFacilitatorClient{
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{
						X402Version: 2,
						Scheme:      "exact",
						Network:     "eip155:1",
					},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	server := Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:1", mockServer),
	)
	_ = server.Initialize(ctx)

	// Request to protected path without payment
	adapter := &mockHTTPAdapter{
		method: "GET",
		path:   "/api",
		url:    "http://example.com/api",
		accept: "application/json",
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/api",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment error, got %s", result.Type)
	}
	if result.Response == nil {
		t.Fatal("Expected response instructions")
	}
	if result.Response.Status != 402 {
		t.Errorf("Expected status 402, got %d", result.Response.Status)
	}
	if result.Response.Headers["PAYMENT-REQUIRED"] == "" {
		t.Error("Expected PAYMENT-REQUIRED header")
	}
}

func TestBuildPaymentRequirementsFromOptionsPreservesOptionExtra(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
					Extra: map[string]interface{}{
						"assetTransferMethod": "permit2",
						"merchantNote":        "route-level-extra",
					},
				},
			},
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}
	mockClient := &mockFacilitatorClient{
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds:      []x402.SupportedKind{{X402Version: 2, Scheme: "exact", Network: "eip155:1"}},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	server := Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:1", mockServer),
	)
	if err := server.Initialize(ctx); err != nil {
		t.Fatalf("Failed to initialize server: %v", err)
	}

	reqCtx := HTTPRequestContext{
		Adapter: &mockHTTPAdapter{method: "GET", path: "/api", url: "http://example.com/api"},
		Path:    "/api",
		Method:  "GET",
	}

	requirements, err := server.BuildPaymentRequirementsFromOptions(ctx, routes["GET /api"].Accepts, reqCtx)
	if err != nil {
		t.Fatalf("Failed to build payment requirements: %v", err)
	}
	if len(requirements) != 1 {
		t.Fatalf("Expected 1 requirement, got %d", len(requirements))
	}
	if requirements[0].Extra["assetTransferMethod"] != "permit2" {
		t.Fatalf("Expected assetTransferMethod passthrough, got %v", requirements[0].Extra["assetTransferMethod"])
	}
	if requirements[0].Extra["merchantNote"] != "route-level-extra" {
		t.Fatalf("Expected merchant extra passthrough, got %v", requirements[0].Extra["merchantNote"])
	}
}

func TestProcessHTTPRequestWithBrowser(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"*": {
			Accepts: PaymentOptions{
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

	mockServer := &mockSchemeServer{scheme: "exact"}
	mockClient := &mockFacilitatorClient{}

	server := Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:1", mockServer),
	)
	_ = server.Initialize(ctx)

	// Browser request
	adapter := &mockHTTPAdapter{
		method: "GET",
		path:   "/content",
		url:    "http://example.com/content",
		accept: "text/html",
		agent:  "Mozilla/5.0",
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/content",
		Method:  "GET",
	}

	paywallConfig := &PaywallConfig{
		AppName: "Test App",
	}

	result := server.ProcessHTTPRequest(ctx, reqCtx, paywallConfig)

	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment error, got %s", result.Type)
	}
	if result.Response == nil {
		t.Fatal("Expected response instructions")
	}
	if !result.Response.IsHTML {
		t.Error("Expected HTML response")
	}
	if result.Response.Headers["Content-Type"] != "text/html" {
		t.Error("Expected text/html content type")
	}

	// Check HTML contains expected elements
	html := result.Response.Body.(string)
	if !strings.Contains(html, "Payment Required") {
		t.Error("Expected 'Payment Required' in HTML")
	}
	if !strings.Contains(html, "Test App") {
		t.Error("Expected app name in HTML")
	}
	if !strings.Contains(html, "http://example.com/content") {
		t.Error("Expected current URL in HTML, got: " + html)
	}
}

func TestProcessHTTPRequestWithPaymentVerified(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"POST /api": {
			Accepts: PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
		},
	}

	mockServer := &mockSchemeServer{
		scheme: "exact",
	}
	mockClient := &mockFacilitatorClient{
		verify: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
			return &x402.VerifyResponse{
				IsValid: true,
				Payer:   "0xpayer",
			}, nil
		},
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:1"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	server := Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:1", mockServer),
	)
	_ = server.Initialize(ctx)

	// Create payment payload that matches the route requirements exactly
	acceptedRequirements := x402.PaymentRequirements{
		Scheme:            "exact",
		Network:           "eip155:1",
		Asset:             "USDC",
		Amount:            "1000000",
		PayTo:             "0xtest",
		MaxTimeoutSeconds: 300,
		Extra: map[string]interface{}{
			"resourceUrl": "http://example.com/api",
		},
	}

	paymentPayload := x402.PaymentPayload{
		X402Version: 2,
		Payload:     map[string]interface{}{"sig": "test"},
		Accepted:    acceptedRequirements,
	}

	payloadJSON, _ := json.Marshal(paymentPayload)
	encoded := base64.StdEncoding.EncodeToString(payloadJSON)

	// Request with payment
	adapter := &mockHTTPAdapter{
		method: "POST",
		path:   "/api",
		url:    "http://example.com/api",
		headers: map[string]string{
			"PAYMENT-SIGNATURE": encoded,
		},
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/api",
		Method:  "POST",
	}

	result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

	if result.Type != ResultPaymentVerified {
		errMsg := ""
		if result.Response != nil {
			if result.Response.Body != nil {
				if bodyStr, ok := result.Response.Body.(string); ok {
					errMsg = bodyStr
				} else if bodyJSON, ok := result.Response.Body.(map[string]interface{}); ok {
					if jsonBytes, err := json.Marshal(bodyJSON); err == nil {
						errMsg = string(jsonBytes)
					}
				}
			}
		}
		t.Errorf("Expected payment verified, got %s. Response body: %v, Full response: %+v", result.Type, errMsg, result.Response)
	}
	if result.PaymentPayload == nil {
		t.Error("Expected payment payload")
	}
	if result.PaymentRequirements == nil {
		t.Error("Expected payment requirements")
	}
}

func TestProcessSettlement(t *testing.T) {
	ctx := context.Background()

	mockClient := &mockFacilitatorClient{
		settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success:     true,
				Transaction: "0xtx",
				Payer:       "0xpayer",
				Network:     "eip155:8453",
			}, nil
		},
	}

	server := Newx402HTTPResourceServer(
		RoutesConfig{},
		x402.WithFacilitatorClient(mockClient),
	)
	_ = server.Initialize(ctx)

	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xtest",
	}

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	// Test settlement processing
	result := server.ProcessSettlement(ctx, payload, requirements, nil, nil)
	if !result.Success {
		t.Fatalf("Unexpected failure: %v", result.ErrorReason)
	}
	if result.Headers == nil {
		t.Fatal("Expected settlement headers")
	}
	if result.Headers["PAYMENT-RESPONSE"] == "" {
		t.Error("Expected PAYMENT-RESPONSE header")
	}
}

func TestProcessSettlement_Failure(t *testing.T) {
	ctx := context.Background()

	mockClient := &mockFacilitatorClient{
		settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			return &x402.SettleResponse{
				Success:     false,
				ErrorReason: "insufficient_funds",
				Network:     "eip155:1",
				Payer:       "0xpayer",
			}, nil
		},
	}

	server := Newx402HTTPResourceServer(
		RoutesConfig{},
		x402.WithFacilitatorClient(mockClient),
	)
	_ = server.Initialize(ctx)

	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Asset:   "USDC",
		Amount:  "1000000",
		PayTo:   "0xtest",
	}

	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	result := server.ProcessSettlement(ctx, payload, requirements, nil, nil)
	if result.Success {
		t.Fatal("Expected settlement failure")
	}
	if result.Headers == nil || result.Headers["PAYMENT-RESPONSE"] == "" {
		t.Error("Expected PAYMENT-RESPONSE header on settlement failure")
	}
	if result.Response == nil {
		t.Fatal("Expected Response to be set on settlement failure")
	}
	if result.Response.Status != 402 {
		t.Errorf("Expected status 402, got %d", result.Response.Status)
	}
	body, ok := result.Response.Body.(map[string]interface{})
	if !ok || len(body) != 0 {
		t.Errorf("Expected empty body {}, got %v", result.Response.Body)
	}
}

func TestProcessSettlement_OverridesFromTransportContext(t *testing.T) {
	ctx := context.Background()

	var capturedRequirements []byte
	mockClient := &mockFacilitatorClient{
		settle: func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
			capturedRequirements = requirementsBytes
			return &x402.SettleResponse{
				Success:     true,
				Transaction: "0xtx",
				Payer:       "0xpayer",
				Network:     "eip155:8453",
			}, nil
		},
	}

	server := Newx402HTTPResourceServer(RoutesConfig{}, x402.WithFacilitatorClient(mockClient))
	_ = server.Initialize(ctx)

	requirements := types.PaymentRequirements{
		Scheme:  "exact",
		Network: "eip155:1",
		Amount:  "1000000",
		PayTo:   "0xtest",
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Accepted:    requirements,
		Payload:     map[string]interface{}{},
	}

	t.Run("reads overrides from response headers", func(t *testing.T) {
		capturedRequirements = nil
		h := http.Header{}
		h.Set(SettlementOverridesHeader, `{"amount":"500"}`)
		tc := &HTTPTransportContext{
			ResponseHeaders: h,
		}

		result := server.ProcessSettlement(ctx, payload, requirements, nil, tc)
		if !result.Success {
			t.Fatalf("unexpected failure: %v", result.ErrorReason)
		}

		var settled types.PaymentRequirements
		if err := json.Unmarshal(capturedRequirements, &settled); err != nil {
			t.Fatalf("failed to unmarshal captured requirements: %v", err)
		}
		if settled.Amount != "500" {
			t.Errorf("expected overridden amount 500, got %s", settled.Amount)
		}
	})

	t.Run("explicit overrides take precedence over header", func(t *testing.T) {
		capturedRequirements = nil
		h := http.Header{}
		h.Set(SettlementOverridesHeader, `{"amount":"500"}`)
		tc := &HTTPTransportContext{
			ResponseHeaders: h,
		}
		explicit := &x402.SettlementOverrides{Amount: "200"}

		result := server.ProcessSettlement(ctx, payload, requirements, explicit, tc)
		if !result.Success {
			t.Fatalf("unexpected failure: %v", result.ErrorReason)
		}

		var settled types.PaymentRequirements
		if err := json.Unmarshal(capturedRequirements, &settled); err != nil {
			t.Fatalf("failed to unmarshal captured requirements: %v", err)
		}
		if settled.Amount != "200" {
			t.Errorf("expected explicit override amount 200, got %s", settled.Amount)
		}
	})

	t.Run("malformed header is ignored", func(t *testing.T) {
		capturedRequirements = nil
		h := http.Header{}
		h.Set(SettlementOverridesHeader, "not-valid-json{{{")
		tc := &HTTPTransportContext{
			ResponseHeaders: h,
		}

		result := server.ProcessSettlement(ctx, payload, requirements, nil, tc)
		if !result.Success {
			t.Fatalf("unexpected failure: %v", result.ErrorReason)
		}

		var settled types.PaymentRequirements
		if err := json.Unmarshal(capturedRequirements, &settled); err != nil {
			t.Fatalf("failed to unmarshal captured requirements: %v", err)
		}
		if settled.Amount != "1000000" {
			t.Errorf("expected original amount 1000000, got %s", settled.Amount)
		}
	})

	t.Run("header is deleted after extraction", func(t *testing.T) {
		h := http.Header{}
		h.Set(SettlementOverridesHeader, `{"amount":"500"}`)
		h.Set("Content-Type", "application/json")
		tc := &HTTPTransportContext{
			ResponseHeaders: h,
		}

		server.ProcessSettlement(ctx, payload, requirements, nil, tc)

		if tc.ResponseHeaders.Get(SettlementOverridesHeader) != "" {
			t.Error("expected settlement-overrides header to be deleted from transport context")
		}
		if tc.ResponseHeaders.Get("Content-Type") == "" {
			t.Error("expected other headers to remain")
		}
	})

	t.Run("nil transport context is safe", func(t *testing.T) {
		result := server.ProcessSettlement(ctx, payload, requirements, nil, nil)
		if !result.Success {
			t.Fatalf("unexpected failure: %v", result.ErrorReason)
		}
	})

	t.Run("nil response headers is safe", func(t *testing.T) {
		tc := &HTTPTransportContext{
			Request:         &HTTPRequestContext{Path: "/test", Method: "GET"},
			ResponseHeaders: nil,
		}
		result := server.ProcessSettlement(ctx, payload, requirements, nil, tc)
		if !result.Success {
			t.Fatalf("unexpected failure: %v", result.ErrorReason)
		}
	})

	t.Run("percent override via header", func(t *testing.T) {
		capturedRequirements = nil
		h := http.Header{}
		h.Set(SettlementOverridesHeader, `{"amount":"50%"}`)
		tc := &HTTPTransportContext{
			ResponseHeaders: h,
		}

		result := server.ProcessSettlement(ctx, payload, requirements, nil, tc)
		if !result.Success {
			t.Fatalf("unexpected failure: %v", result.ErrorReason)
		}

		var settled types.PaymentRequirements
		if err := json.Unmarshal(capturedRequirements, &settled); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}
		// 50% of 1000000 = 500000
		if settled.Amount != "500000" {
			t.Errorf("expected 500000, got %s", settled.Amount)
		}
	})

	t.Run("dollar override via header with default decimals", func(t *testing.T) {
		capturedRequirements = nil
		h := http.Header{}
		h.Set(SettlementOverridesHeader, `{"amount":"$0.001"}`)
		tc := &HTTPTransportContext{
			ResponseHeaders: h,
		}

		result := server.ProcessSettlement(ctx, payload, requirements, nil, tc)
		if !result.Success {
			t.Fatalf("unexpected failure: %v", result.ErrorReason)
		}

		var settled types.PaymentRequirements
		if err := json.Unmarshal(capturedRequirements, &settled); err != nil {
			t.Fatalf("failed to unmarshal: %v", err)
		}
		// $0.001 with 6 decimals = 1000
		if settled.Amount != "1000" {
			t.Errorf("expected 1000, got %s", settled.Amount)
		}
	})

}

func TestParseRoutePattern(t *testing.T) {
	tests := []struct {
		pattern     string
		expectVerb  string
		expectPath  string
		testPath    string
		shouldMatch bool
	}{
		{
			pattern:     "GET /api",
			expectVerb:  "GET",
			expectPath:  "/api",
			testPath:    "/api",
			shouldMatch: true,
		},
		{
			pattern:     "POST /api/*",
			expectVerb:  "POST",
			expectPath:  "/api/*",
			testPath:    "/api/users",
			shouldMatch: true,
		},
		{
			pattern:     "/public",
			expectVerb:  "*",
			expectPath:  "/public",
			testPath:    "/public",
			shouldMatch: true,
		},
		{
			pattern:     "*",
			expectVerb:  "*",
			expectPath:  "*",
			testPath:    "/anything",
			shouldMatch: true,
		},
		{
			pattern:     "GET /api/[id]",
			expectVerb:  "GET",
			expectPath:  "/api/[id]",
			testPath:    "/api/123",
			shouldMatch: true,
		},
		{
			pattern:     "GET /api/users/:userId",
			expectVerb:  "GET",
			expectPath:  "/api/users/:userId",
			testPath:    "/api/users/456",
			shouldMatch: true,
		},
		{
			pattern:     "GET /api/users/:userId/posts/:postId",
			expectVerb:  "GET",
			expectPath:  "/api/users/:userId/posts/:postId",
			testPath:    "/api/users/42/posts/7",
			shouldMatch: true,
		},
		{
			pattern:     "/api/:version/items",
			expectVerb:  "*",
			expectPath:  "/api/:version/items",
			testPath:    "/api/v2/items",
			shouldMatch: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.pattern, func(t *testing.T) {
			verb, path, regex := parseRoutePattern(tt.pattern)

			if verb != tt.expectVerb {
				t.Errorf("Expected verb %s, got %s", tt.expectVerb, verb)
			}

			if path != tt.expectPath {
				t.Errorf("Expected path %s, got %s", tt.expectPath, path)
			}

			normalized := normalizePath(tt.testPath)
			if regex.MatchString(normalized) != tt.shouldMatch {
				t.Errorf("Expected match=%v for path %s", tt.shouldMatch, tt.testPath)
			}
		})
	}
}

func TestNormalizePath(t *testing.T) {
	tests := []struct {
		input    string
		expected string
	}{
		{"/api", "/api"},
		{"/api/", "/api"},
		{"/api//users", "/api/users"},
		{"/api?query=1", "/api"},
		{"/api#fragment", "/api"},
		{"/api%20space", "/api space"},
		{"", "/"},
	}

	for _, tt := range tests {
		t.Run(tt.input, func(t *testing.T) {
			result := normalizePath(tt.input)
			if result != tt.expected {
				t.Errorf("Expected %s, got %s", tt.expected, result)
			}
		})
	}
}

func TestGetDisplayAmount(t *testing.T) {
	server := Newx402HTTPResourceServer(RoutesConfig{})

	tests := []struct {
		name     string
		required x402.PaymentRequired
		expected float64
	}{
		{
			name: "USDC with 6 decimals",
			required: x402.PaymentRequired{
				Accepts: []x402.PaymentRequirements{
					{Amount: "5000000"},
				},
			},
			expected: 5.0,
		},
		{
			name: "Small amount",
			required: x402.PaymentRequired{
				Accepts: []x402.PaymentRequirements{
					{Amount: "100000"},
				},
			},
			expected: 0.1,
		},
		{
			name: "Invalid amount",
			required: x402.PaymentRequired{
				Accepts: []x402.PaymentRequirements{
					{Amount: "not-a-number"},
				},
			},
			expected: 0.0,
		},
		{
			name:     "No requirements",
			required: x402.PaymentRequired{},
			expected: 0.0,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := server.getDisplayAmount(tt.required)
			if result != tt.expected {
				t.Errorf("Expected %f, got %f", tt.expected, result)
			}
		})
	}
}

// ============================================================================
// ValidateRouteConfiguration Tests
// ============================================================================

func TestValidateRouteConfiguration_Success(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
		},
	}

	mockClient := &mockFacilitatorClient{
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:8453"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	server := Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:8453", &mockSchemeServer{scheme: "exact"}),
	)

	err := server.Initialize(ctx)
	if err != nil {
		t.Fatalf("Expected no error, got: %v", err)
	}
}

func TestValidateRouteConfiguration_MissingScheme(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
		},
	}

	// Facilitator supports the scheme/network, but no scheme server is registered
	mockClient := &mockFacilitatorClient{
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds: []x402.SupportedKind{
					{X402Version: 2, Scheme: "exact", Network: "eip155:8453"},
				},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	// No WithSchemeServer - scheme is not registered
	server := Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
	)

	// Manually call parent Initialize to populate facilitatorClients without validation
	_ = server.X402ResourceServer.Initialize(ctx)

	// Now validate routes
	err := server.validateRouteConfiguration()
	if err == nil {
		t.Fatal("Expected validation error for missing scheme")
	}

	var configErr *RouteConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("Expected RouteConfigurationError, got %T: %v", err, err)
	}

	if len(configErr.Errors) != 1 {
		t.Fatalf("Expected 1 error, got %d", len(configErr.Errors))
	}
	if configErr.Errors[0].Reason != "missing_scheme" {
		t.Errorf("Expected reason 'missing_scheme', got %q", configErr.Errors[0].Reason)
	}
	if configErr.Errors[0].Network != "eip155:8453" {
		t.Errorf("Expected network 'eip155:8453', got %q", configErr.Errors[0].Network)
	}
}

func TestValidateRouteConfiguration_MissingFacilitator(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
			},
		},
	}

	// Facilitator does NOT support this network/scheme combo
	mockClient := &mockFacilitatorClient{
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds:      []x402.SupportedKind{},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	server := Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:8453", &mockSchemeServer{scheme: "exact"}),
	)

	err := server.Initialize(ctx)
	if err == nil {
		t.Fatal("Expected validation error for missing facilitator")
	}

	var configErr *RouteConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("Expected RouteConfigurationError, got %T: %v", err, err)
	}

	if len(configErr.Errors) != 1 {
		t.Fatalf("Expected 1 error, got %d", len(configErr.Errors))
	}
	if configErr.Errors[0].Reason != "missing_facilitator" {
		t.Errorf("Expected reason 'missing_facilitator', got %q", configErr.Errors[0].Reason)
	}
}

func TestValidateRouteConfiguration_MultipleErrors(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:8453"},
				{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "solana:mainnet"},
			},
		},
	}

	// Facilitator supports neither network
	mockClient := &mockFacilitatorClient{
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds:      []x402.SupportedKind{},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	// No scheme servers registered
	server := Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
	)

	err := server.Initialize(ctx)
	if err == nil {
		t.Fatal("Expected validation errors")
	}

	var configErr *RouteConfigurationError
	if !errors.As(err, &configErr) {
		t.Fatalf("Expected RouteConfigurationError, got %T: %v", err, err)
	}

	if len(configErr.Errors) != 2 {
		t.Fatalf("Expected 2 errors, got %d: %v", len(configErr.Errors), configErr.Errors)
	}

	// Both should be missing_scheme since no schemes are registered
	for _, e := range configErr.Errors {
		if e.Reason != "missing_scheme" {
			t.Errorf("Expected reason 'missing_scheme', got %q", e.Reason)
		}
	}
}

func TestValidateRouteConfiguration_EmptyRoutes(t *testing.T) {
	ctx := context.Background()

	server := Newx402HTTPResourceServer(RoutesConfig{})

	err := server.Initialize(ctx)
	if err != nil {
		t.Fatalf("Expected no error for empty routes, got: %v", err)
	}
}

func TestValidateRouteConfiguration_ErrorMessage(t *testing.T) {
	configErr := &RouteConfigurationError{
		Errors: []RouteValidationError{
			{
				RoutePattern: "GET /api",
				Scheme:       "exact",
				Network:      "eip155:8453",
				Reason:       "missing_scheme",
				Message:      `Route "GET /api": No scheme implementation registered for "exact" on network "eip155:8453"`,
			},
		},
	}

	errMsg := configErr.Error()
	if !strings.Contains(errMsg, "x402 Route Configuration Errors:") {
		t.Error("Expected error message header")
	}
	if !strings.Contains(errMsg, "eip155:8453") {
		t.Errorf("Expected network in error message, got: %s", errMsg)
	}
	if !strings.Contains(errMsg, "No scheme implementation registered") {
		t.Errorf("Expected scheme error detail in message, got: %s", errMsg)
	}
}

// Mock scheme server for testing
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

// Mock facilitator client
type mockFacilitatorClient struct {
	verify    func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error)
	settle    func(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error)
	supported func(ctx context.Context) (x402.SupportedResponse, error)
}

func (m *mockFacilitatorClient) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	if m.verify != nil {
		return m.verify(ctx, payloadBytes, requirementsBytes)
	}
	return &x402.VerifyResponse{IsValid: true, Payer: "0xmock"}, nil
}

func (m *mockFacilitatorClient) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
	if m.settle != nil {
		return m.settle(ctx, payloadBytes, requirementsBytes)
	}
	return &x402.SettleResponse{Success: true, Transaction: "0xmock", Network: "eip155:1", Payer: "0xmock"}, nil
}

func (m *mockFacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	if m.supported != nil {
		return m.supported(ctx)
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
// OnProtectedRequest Hook Tests
// ============================================================================

func TestOnProtectedRequest_GrantAccess(t *testing.T) {
	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"}},
		},
	}

	server := Newx402HTTPResourceServer(routes).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			return &ProtectedRequestHookResult{GrantAccess: true}, nil
		})

	reqCtx := HTTPRequestContext{
		Adapter: &mockHTTPAdapter{method: "GET", path: "/api", url: "http://example.com/api"},
		Path:    "/api",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)
	if result.Type != ResultNoPaymentRequired {
		t.Errorf("Expected no-payment-required, got %s", result.Type)
	}
}

func TestOnProtectedRequest_Abort(t *testing.T) {
	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"}},
		},
	}

	server := Newx402HTTPResourceServer(routes).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			return &ProtectedRequestHookResult{Abort: true, Reason: "forbidden"}, nil
		})

	reqCtx := HTTPRequestContext{
		Adapter: &mockHTTPAdapter{method: "GET", path: "/api", url: "http://example.com/api"},
		Path:    "/api",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)
	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment-error, got %s", result.Type)
	}
	if result.Response == nil {
		t.Fatal("Expected response instructions")
	}
	if result.Response.Status != 403 {
		t.Errorf("Expected status 403, got %d", result.Response.Status)
	}
	body, ok := result.Response.Body.(map[string]string)
	if !ok {
		t.Fatal("Expected body to be map[string]string")
	}
	if body["error"] != "forbidden" {
		t.Errorf("Expected error 'forbidden', got '%s'", body["error"])
	}
}

func TestOnProtectedRequest_Continue(t *testing.T) {
	ctx := context.Background()

	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"}},
		},
	}

	mockServer := &mockSchemeServer{scheme: "exact"}
	mockClient := &mockFacilitatorClient{
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds:      []x402.SupportedKind{{X402Version: 2, Scheme: "exact", Network: "eip155:1"}},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	// Hook returns nil — should continue to payment flow
	server := Newx402HTTPResourceServer(routes, x402.WithFacilitatorClient(mockClient), x402.WithSchemeServer("eip155:1", mockServer)).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			return nil, nil
		})
	_ = server.Initialize(ctx)

	reqCtx := HTTPRequestContext{
		Adapter: &mockHTTPAdapter{method: "GET", path: "/api", url: "http://example.com/api", accept: "application/json"},
		Path:    "/api",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(ctx, reqCtx, nil)
	// Without a payment header, should get 402
	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment-error (402), got %s", result.Type)
	}
	if result.Response != nil && result.Response.Status != 402 {
		t.Errorf("Expected status 402, got %d", result.Response.Status)
	}
}

func TestOnProtectedRequest_MultipleHooks_FirstNonNilWins(t *testing.T) {
	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"}},
		},
	}

	callOrder := []string{}

	server := Newx402HTTPResourceServer(routes).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			callOrder = append(callOrder, "hook1")
			return nil, nil // no opinion
		}).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			callOrder = append(callOrder, "hook2")
			return &ProtectedRequestHookResult{GrantAccess: true}, nil
		}).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			callOrder = append(callOrder, "hook3")
			return &ProtectedRequestHookResult{Abort: true, Reason: "should not reach"}, nil
		})

	reqCtx := HTTPRequestContext{
		Adapter: &mockHTTPAdapter{method: "GET", path: "/api", url: "http://example.com/api"},
		Path:    "/api",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)
	if result.Type != ResultNoPaymentRequired {
		t.Errorf("Expected no-payment-required, got %s", result.Type)
	}
	if len(callOrder) != 2 || callOrder[0] != "hook1" || callOrder[1] != "hook2" {
		t.Errorf("Expected [hook1, hook2], got %v", callOrder)
	}
}

func TestOnProtectedRequest_HookError(t *testing.T) {
	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"}},
		},
	}

	server := Newx402HTTPResourceServer(routes).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			return nil, errors.New("hook failed")
		})

	reqCtx := HTTPRequestContext{
		Adapter: &mockHTTPAdapter{method: "GET", path: "/api", url: "http://example.com/api"},
		Path:    "/api",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)
	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment-error, got %s", result.Type)
	}
	if result.Response == nil {
		t.Fatal("Expected response instructions")
	}
	if result.Response.Status != 500 {
		t.Errorf("Expected status 500, got %d", result.Response.Status)
	}
}

func TestOnProtectedRequest_ContextPassing(t *testing.T) {
	routes := RoutesConfig{
		"GET /api/data": {
			Accepts:     PaymentOptions{{Scheme: "exact", PayTo: "0xtest", Price: "$2.00", Network: "eip155:1"}},
			Description: "Data endpoint",
		},
	}

	var capturedReqCtx HTTPRequestContext
	var capturedRoute RouteConfig

	server := Newx402HTTPResourceServer(routes).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			capturedReqCtx = reqCtx
			capturedRoute = route
			return &ProtectedRequestHookResult{GrantAccess: true}, nil
		})

	reqCtx := HTTPRequestContext{
		Adapter: &mockHTTPAdapter{method: "GET", path: "/api/data", url: "http://example.com/api/data"},
		Path:    "/api/data",
		Method:  "GET",
	}

	server.ProcessHTTPRequest(context.Background(), reqCtx, nil)

	if capturedReqCtx.Path != "/api/data" {
		t.Errorf("Expected path '/api/data', got '%s'", capturedReqCtx.Path)
	}
	if capturedReqCtx.Method != "GET" {
		t.Errorf("Expected method 'GET', got '%s'", capturedReqCtx.Method)
	}
	if capturedRoute.Description != "Data endpoint" {
		t.Errorf("Expected description 'Data endpoint', got '%s'", capturedRoute.Description)
	}
	if len(capturedRoute.Accepts) != 1 || capturedRoute.Accepts[0].Price != "$2.00" {
		t.Errorf("Expected route accepts with price $2.00, got %+v", capturedRoute.Accepts)
	}
}

func TestOnProtectedRequest_UnmatchedRoute_HookNotCalled(t *testing.T) {
	routes := RoutesConfig{
		"GET /api": {
			Accepts: PaymentOptions{{Scheme: "exact", PayTo: "0xtest", Price: "$1.00", Network: "eip155:1"}},
		},
	}

	hookCalled := false
	server := Newx402HTTPResourceServer(routes).
		OnProtectedRequest(func(ctx context.Context, reqCtx HTTPRequestContext, route RouteConfig) (*ProtectedRequestHookResult, error) {
			hookCalled = true
			return &ProtectedRequestHookResult{Abort: true, Reason: "should not be called"}, nil
		})

	reqCtx := HTTPRequestContext{
		Adapter: &mockHTTPAdapter{method: "GET", path: "/public", url: "http://example.com/public"},
		Path:    "/public",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)
	if result.Type != ResultNoPaymentRequired {
		t.Errorf("Expected no-payment-required, got %s", result.Type)
	}
	if hookCalled {
		t.Error("Hook should not be called for unmatched routes")
	}
}
