package integration_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"strings"
	"testing"

	x402 "github.com/coinbase/x402/go"
	x402http "github.com/coinbase/x402/go/http"
	"github.com/coinbase/x402/go/test/mocks/cash"
	"github.com/coinbase/x402/go/types"
)

// mockHTTPAdapter implements the HTTPAdapter interface for testing
type mockHTTPAdapter struct {
	headers map[string]string
	method  string
	path    string
	url     string
}

func (m *mockHTTPAdapter) GetHeader(name string) string {
	if m.headers == nil {
		return ""
	}
	// Check both cases
	if val, ok := m.headers[name]; ok {
		return val
	}
	// Try lowercase
	if val, ok := m.headers[strings.ToLower(name)]; ok {
		return val
	}
	// Try uppercase
	if val, ok := m.headers[strings.ToUpper(name)]; ok {
		return val
	}
	return ""
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
	return "application/json"
}

func (m *mockHTTPAdapter) GetUserAgent() string {
	return "TestClient/1.0"
}

// TestHTTPIntegration tests the integration between x402HTTPClient, x402HTTPResourceServer, and x402Facilitator
func TestHTTPIntegration(t *testing.T) {
	t.Run("Cash Flow - x402HTTPClient / x402HTTPResourceServer / x402Facilitator", func(t *testing.T) {
		ctx := context.Background()

		// Setup routes configuration
		routes := x402http.RoutesConfig{
			"/api/protected": {
				Accepts: x402http.PaymentOptions{
					{
						Scheme:  "cash",
						PayTo:   "merchant@example.com",
						Price:   "$0.10",
						Network: "x402:cash",
					},
				},
				Description: "Access to protected API",
				MimeType:    "application/json",
			},
		}

		// Setup facilitator with cash scheme
		facilitator := x402.Newx402Facilitator()
		facilitator.Register([]x402.Network{"x402:cash"}, cash.NewSchemeNetworkFacilitator())

		// Create facilitator client wrapper
		facilitatorClient := cash.NewFacilitatorClient(facilitator)

		// Setup x402 client with cash scheme
		x402Client := x402.Newx402Client()
		x402Client.Register("x402:cash", cash.NewSchemeNetworkClient("John"))

		// Setup HTTP client wrapper
		httpClient := x402http.Newx402HTTPClient(x402Client)

		// Setup HTTP server
		server := x402http.Newx402HTTPResourceServer(
			routes,
			x402.WithFacilitatorClient(facilitatorClient),
		)
		server.Register("x402:cash", cash.NewSchemeNetworkServer())

		// Initialize server to fetch supported kinds
		err := server.Initialize(ctx)
		if err != nil {
			t.Fatalf("Failed to initialize server: %v", err)
		}

		// Create mock adapter for initial request (no payment)
		mockAdapter := &mockHTTPAdapter{
			headers: map[string]string{},
			method:  "GET",
			path:    "/api/protected",
			url:     "https://example.com/api/protected",
		}

		// Create request context
		reqCtx := x402http.HTTPRequestContext{
			Adapter: mockAdapter,
			Path:    "/api/protected",
			Method:  "GET",
		}

		// Process initial request without payment - should get 402 response
		httpProcessResult := server.ProcessHTTPRequest(ctx, reqCtx, nil)

		if httpProcessResult.Type != x402http.ResultPaymentError {
			t.Fatalf("Expected payment-error result, got %s", httpProcessResult.Type)
		}

		if httpProcessResult.Response == nil {
			t.Fatal("Expected response instructions, got nil")
		}

		initial402Response := httpProcessResult.Response

		// Verify 402 response
		if initial402Response.Status != 402 {
			t.Errorf("Expected status 402, got %d", initial402Response.Status)
		}

		if initial402Response.Headers["PAYMENT-REQUIRED"] == "" {
			t.Error("Expected PAYMENT-REQUIRED header")
		}

		if initial402Response.IsHTML {
			t.Error("Expected non-HTML response for JSON accept header")
		}

		// Client responds to PaymentRequired
		paymentRequired, err := httpClient.GetPaymentRequiredResponse(
			initial402Response.Headers,
			nil, // No body for v2
		)
		if err != nil {
			t.Fatalf("Failed to get payment required response: %v", err)
		}

		// Convert PaymentRequired.Accepts to V2 (assuming response is V2)
		var acceptsV2 []types.PaymentRequirements
		for _, acc := range paymentRequired.Accepts {
			acceptsV2 = append(acceptsV2, types.PaymentRequirements{
				Scheme:  acc.Scheme,
				Network: string(acc.Network),
				Asset:   acc.Asset,
				Amount:  acc.Amount,
				PayTo:   acc.PayTo,
				Extra:   acc.Extra,
			})
		}

		selected, err := x402Client.SelectPaymentRequirements(acceptsV2)
		if err != nil {
			t.Fatalf("Failed to select payment requirements: %v", err)
		}

		payload, err := x402Client.CreatePaymentPayload(
			ctx,
			selected,
			nil, // Cash doesn't use resource
			nil, // Cash doesn't use extensions
		)
		if err != nil {
			t.Fatalf("Failed to create payment payload: %v", err)
		}

		// Marshal payload to bytes for header encoding
		payloadBytes, _ := json.Marshal(payload)
		requestHeaders, err := httpClient.EncodePaymentSignatureHeader(payloadBytes)
		if err != nil {
			t.Fatalf("Failed to encode payment signature header: %v", err)
		}

		// Update mock adapter with payment header
		mockAdapter.headers = requestHeaders

		// Process request with payment
		httpProcessResult2 := server.ProcessHTTPRequest(ctx, reqCtx, nil)

		if httpProcessResult2.Type != x402http.ResultPaymentVerified {
			t.Fatalf("Expected payment-verified result, got %s", httpProcessResult2.Type)
		}

		if httpProcessResult2.PaymentPayload == nil {
			t.Fatal("Expected payment payload in verified result")
		}

		if httpProcessResult2.PaymentRequirements == nil {
			t.Fatal("Expected payment requirements in verified result")
		}

		// Process settlement (simulating successful response)
		settlementResult := server.ProcessSettlement(
			ctx,
			*httpProcessResult2.PaymentPayload,
			*httpProcessResult2.PaymentRequirements,
			nil,
			nil,
		)
		if !settlementResult.Success {
			t.Fatalf("Failed to process settlement: %v", settlementResult.ErrorReason)
		}

		if settlementResult.Headers == nil {
			t.Fatal("Expected settlement headers")
		}

		if settlementResult.Headers["PAYMENT-RESPONSE"] == "" {
			t.Error("Expected PAYMENT-RESPONSE header")
		}

		// Decode and verify settlement response
		settleData, err := base64.StdEncoding.DecodeString(settlementResult.Headers["PAYMENT-RESPONSE"])
		if err != nil {
			t.Fatalf("Failed to decode settlement response: %v", err)
		}

		var settleResponse x402.SettleResponse
		err = json.Unmarshal(settleData, &settleResponse)
		if err != nil {
			t.Fatalf("Failed to unmarshal settlement response: %v", err)
		}

		if !settleResponse.Success {
			t.Errorf("Expected successful settlement, got error: %s", settleResponse.ErrorReason)
		}
	})
}
