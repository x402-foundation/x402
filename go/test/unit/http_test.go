package unit_test

import (
	"context"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/test/mocks/cash"
)

// mockBrowserHTTPAdapter implements the HTTPAdapter interface for browser testing
type mockBrowserHTTPAdapter struct {
	headers map[string]string
	method  string
	path    string
	url     string
}

func (m *mockBrowserHTTPAdapter) GetHeader(name string) string {
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

func (m *mockBrowserHTTPAdapter) GetMethod() string {
	return m.method
}

func (m *mockBrowserHTTPAdapter) GetPath() string {
	return m.path
}

func (m *mockBrowserHTTPAdapter) GetURL() string {
	return m.url
}

func (m *mockBrowserHTTPAdapter) GetAcceptHeader() string {
	return "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
}

func (m *mockBrowserHTTPAdapter) GetUserAgent() string {
	return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36"
}

// TestHTTPBrowserPaywall tests the HTTP integration with browser client (HTML paywall)
func TestHTTPBrowserPaywall(t *testing.T) {
	t.Run("Browser Flow - HTML Paywall Response", func(t *testing.T) {
		ctx := context.Background()

		// Setup routes configuration
		routes := x402http.RoutesConfig{
			"/web/protected": {
				Accepts: x402http.PaymentOptions{
					{
						Scheme:  "cash",
						PayTo:   "merchant@example.com",
						Price:   "$5.00",
						Network: "x402:cash",
					},
				},
				Description: "Premium Web Content",
				MimeType:    "text/html",
			},
		}

		// Setup facilitator with cash scheme
		facilitator := x402.Newx402Facilitator()
		facilitator.Register([]x402.Network{"x402:cash"}, cash.NewSchemeNetworkFacilitator())

		// Create facilitator client wrapper
		facilitatorClient := cash.NewFacilitatorClient(facilitator)

		// Setup HTTP server
		server := x402http.Newx402HTTPResourceServer(
			routes,
			x402.WithFacilitatorClient(facilitatorClient),
		)
		server.Register("x402:cash", cash.NewSchemeNetworkServer())

		// Initialize server
		err := server.Initialize(ctx)
		if err != nil {
			t.Fatalf("Failed to initialize server: %v", err)
		}

		// Create mock browser adapter
		mockBrowserAdapter := &mockBrowserHTTPAdapter{
			headers: map[string]string{},
			method:  "GET",
			path:    "/web/protected",
			url:     "https://example.com/web/protected",
		}

		// Create request context
		reqCtx := x402http.HTTPRequestContext{
			Adapter: mockBrowserAdapter,
			Path:    "/web/protected",
			Method:  "GET",
		}

		// Configure paywall
		paywallConfig := &x402http.PaywallConfig{
			AppName: "Test App",
			AppLogo: "/logo.png",
			Testnet: true,
		}

		// Process browser request without payment
		httpProcessResult := server.ProcessHTTPRequest(ctx, reqCtx, paywallConfig)

		if httpProcessResult.Type != x402http.ResultPaymentError {
			t.Fatalf("Expected payment-error result, got %s", httpProcessResult.Type)
		}

		if httpProcessResult.Response == nil {
			t.Fatal("Expected response instructions, got nil")
		}

		// Verify HTML paywall response
		if httpProcessResult.Response.Status != 402 {
			t.Errorf("Expected status 402, got %d", httpProcessResult.Response.Status)
		}

		if !httpProcessResult.Response.IsHTML {
			t.Error("Expected HTML response for browser")
		}

		if httpProcessResult.Response.Headers["Content-Type"] != "text/html" {
			t.Errorf("Expected Content-Type text/html, got %s", httpProcessResult.Response.Headers["Content-Type"])
		}

		// Verify HTML contains paywall elements
		htmlBody, ok := httpProcessResult.Response.Body.(string)
		if !ok {
			t.Fatal("Expected HTML body as string")
		}

		// Check for key paywall elements in the new template structure
		expectedElements := []string{
			"window.x402 =", // Check for injected config
			"paymentRequired:",
			"Premium Web Content", // Inside JSON
			"0.000005",            // Amount in config
			"Test App",            // App name
			"/logo.png",           // App logo
		}

		for _, element := range expectedElements {
			if !strings.Contains(htmlBody, element) {
				t.Errorf("Expected HTML to contain '%s'\nActual HTML:\n%s", element, htmlBody)
			}
		}
	})
}
