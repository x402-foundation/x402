package integration_test

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
	"github.com/x402-foundation/x402/go/v2/test/mocks/cash"
	"github.com/x402-foundation/x402/go/v2/types"
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

// TestHTTPIntegration_FacilitatorReturnsIsValidFalse is a regression test for the security
// bug where a facilitator HTTP-200 response carrying {"isValid":false} was not treated as a
// hard gate failure. It exercises the full local SDK stack:
//
//	httptest facilitator stub (HTTP 200, {"isValid":false})
//	  → x402http.HTTPFacilitatorClient.verifyHTTP (parses response)
//	  → x402.VerifyPaymentWithExtensions (new IsValid guard)
//	  → x402http.ProcessHTTPRequest (must return ResultPaymentError, not ResultPaymentVerified)
//
// No real blockchain or external service is used.
func TestHTTPIntegration_FacilitatorReturnsIsValidFalse(t *testing.T) {
	for _, tc := range []struct {
		name          string
		invalidReason string
		wantReason    string
	}{
		{
			name:          "isValid false with reason",
			invalidReason: "insufficient_balance",
			wantReason:    "insufficient_balance",
		},
		{
			name:          "isValid false without reason",
			invalidReason: "",
			wantReason:    x402.ErrCodeInvalidPayment,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx := context.Background()

			// Stand up a minimal HTTP facilitator stub. /supported tells the resource
			// server which schemes are available; /verify always returns isValid:false
			// with HTTP 200, simulating a facilitator that is reachable but rejects
			// the payment at the protocol level.
			stub := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				switch r.URL.Path {
				case "/supported":
					json.NewEncoder(w).Encode(map[string]interface{}{
						"kinds": []map[string]interface{}{
							{"x402Version": 2, "scheme": "cash", "network": "x402:cash"},
						},
						"extensions": []string{},
						"signers":    map[string][]string{},
					})
				case "/verify":
					resp := map[string]interface{}{"isValid": false}
					if tc.invalidReason != "" {
						resp["invalidReason"] = tc.invalidReason
					}
					json.NewEncoder(w).Encode(resp)
				default:
					w.WriteHeader(http.StatusNotFound)
				}
			}))
			defer stub.Close()

			// Wire the real HTTPFacilitatorClient to the stub — this exercises the
			// full HTTP parse path (verifyHTTP → parseVerifySuccessResponse).
			facilitatorClient := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
				URL: stub.URL,
			})

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
				},
			}

			server := x402http.Newx402HTTPResourceServer(
				routes,
				x402.WithFacilitatorClient(facilitatorClient),
			)
			server.Register("x402:cash", cash.NewSchemeNetworkServer())

			if err := server.Initialize(ctx); err != nil {
				t.Fatalf("server.Initialize: %v", err)
			}

			// Build a structurally valid payment payload using the cash client so
			// the server accepts the header encoding and reaches the facilitator call.
			x402Client := x402.Newx402Client()
			x402Client.Register("x402:cash", cash.NewSchemeNetworkClient("Alice"))
			httpClient := x402http.Newx402HTTPClient(x402Client)

			requirements := cash.BuildPaymentRequirements("merchant@example.com", "USD", "0.10")
			payload, err := x402Client.CreatePaymentPayload(ctx, requirements, nil, nil)
			if err != nil {
				t.Fatalf("CreatePaymentPayload: %v", err)
			}
			payloadBytes, _ := json.Marshal(payload)
			paymentHeaders, err := httpClient.EncodePaymentSignatureHeader(payloadBytes)
			if err != nil {
				t.Fatalf("EncodePaymentSignatureHeader: %v", err)
			}

			reqCtx := x402http.HTTPRequestContext{
				Adapter: &mockHTTPAdapter{
					headers: paymentHeaders,
					method:  "GET",
					path:    "/api/protected",
					url:     "https://example.com/api/protected",
				},
				Path:   "/api/protected",
				Method: "GET",
			}

			result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

			// The gate must not pass — protected handler must not execute.
			if result.Type == x402http.ResultPaymentVerified {
				t.Fatal("ProcessHTTPRequest returned ResultPaymentVerified for isValid:false — payment gate bypass")
			}
			if result.Type != x402http.ResultPaymentError {
				t.Fatalf("Expected ResultPaymentError, got %s", result.Type)
			}
			if result.Response == nil {
				t.Fatal("Expected 402 response instructions, got nil")
			}
			if result.Response.Status != 402 {
				t.Fatalf("Expected HTTP 402, got %d", result.Response.Status)
			}

			// The PAYMENT-REQUIRED header must be set so the client knows how to retry.
			if result.Response.Headers["PAYMENT-REQUIRED"] == "" {
				t.Error("Expected PAYMENT-REQUIRED header in 402 response")
			}
		})
	}
}
