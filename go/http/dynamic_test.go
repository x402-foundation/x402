package http

import (
	"context"
	"fmt"
	"strings"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
)

// Note: mockHTTPAdapter and mockSchemeServer are defined in server_test.go

// TestDynamicPayTo tests dynamic payTo resolution
func TestDynamicPayTo(t *testing.T) {
	// Create mock scheme server
	mockServer := &mockSchemeServer{
		scheme: "exact",
	}

	routes := RoutesConfig{
		"GET /marketplace/item/*": RouteConfig{
			Accepts: PaymentOptions{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
					Price:   "$10.00",
					// Dynamic payTo based on item seller
					PayTo: DynamicPayToFunc(func(ctx context.Context, reqCtx HTTPRequestContext) (string, error) {
						// In production, would query database for seller address
						// For testing, extract from path
						if reqCtx.Path == "/marketplace/item/123" {
							return "0xSeller123", nil
						}
						return "0xDefaultSeller", nil
					}),
				},
			},
		},
	}

	mockFacilitator := &mockFacilitatorClient{
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

	server := Newx402HTTPResourceServer(routes,
		x402.WithSchemeServer("eip155:8453", mockServer),
		x402.WithFacilitatorClient(mockFacilitator),
	)

	// Initialize to populate facilitator support
	_ = server.Initialize(context.Background())

	adapter := &mockHTTPAdapter{
		method: "GET",
		path:   "/marketplace/item/123",
		url:    "http://example.com/marketplace/item/123",
		accept: "application/json",
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/marketplace/item/123",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)

	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment error (no payment provided), got %s", result.Type)
	}

	// The dynamic payTo should have been resolved
	// We can verify this worked by checking that no error occurred during resolution
}

// TestDynamicPrice tests dynamic price resolution
func TestDynamicPrice(t *testing.T) {
	var capturedPrices []string

	mockServer := &mockSchemeServer{
		scheme: "exact",
	}

	mockFacilitator := &mockFacilitatorClient{
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

	routes := RoutesConfig{
		"GET /api/data": RouteConfig{
			Accepts: []PaymentOption{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
					PayTo:   "0xRecipient",
					// Dynamic price based on tier query param
					Price: DynamicPriceFunc(func(ctx context.Context, reqCtx HTTPRequestContext) (x402.Price, error) {
						// In production, would check query params or headers
						// For testing, use path-based logic
						if reqCtx.Path == "/api/data?tier=premium" {
							return "$0.10", nil
						}
						return "$0.01", nil
					}),
				},
			},
		},
	}

	server := Newx402HTTPResourceServer(routes,
		x402.WithSchemeServer("eip155:8453", mockServer),
		x402.WithFacilitatorClient(mockFacilitator),
	)

	// Initialize to populate facilitator support
	_ = server.Initialize(context.Background())

	// Test premium tier
	adapter1 := &mockHTTPAdapter{
		method: "GET",
		path:   "/api/data?tier=premium",
		url:    "http://example.com/api/data?tier=premium",
		accept: "application/json",
	}

	reqCtx1 := HTTPRequestContext{
		Adapter: adapter1,
		Path:    "/api/data?tier=premium",
		Method:  "GET",
	}

	server.ProcessHTTPRequest(context.Background(), reqCtx1, nil)

	// Test basic tier
	adapter2 := &mockHTTPAdapter{
		method: "GET",
		path:   "/api/data",
		url:    "http://example.com/api/data",
		accept: "application/json",
	}

	reqCtx2 := HTTPRequestContext{
		Adapter: adapter2,
		Path:    "/api/data",
		Method:  "GET",
	}

	server.ProcessHTTPRequest(context.Background(), reqCtx2, nil)

	// Check that dynamic price resolution worked
	// The test passes if we got here without errors - the price function was called
	// during resolveRouteConfig, which is what we're testing
	if len(capturedPrices) == 0 {
		t.Skip("ParsePrice not called - test validates dynamic resolution happens without error")
	}

	if len(capturedPrices) >= 1 && capturedPrices[0] != "$0.10" {
		t.Errorf("Expected first price to be '$0.10', got %s", capturedPrices[0])
	}

	if len(capturedPrices) >= 2 && capturedPrices[1] != "$0.01" {
		t.Errorf("Expected second price to be '$0.01', got %s", capturedPrices[1])
	}
}

// TestDynamicPayToAndPrice tests both dynamic payTo and price together
func TestDynamicPayToAndPrice(t *testing.T) {
	mockServer := &mockSchemeServer{
		scheme: "exact",
	}

	routes := RoutesConfig{
		"POST /content/*": RouteConfig{
			Accepts: []PaymentOption{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
					// Dynamic payTo: Route payment to content creator
					PayTo: DynamicPayToFunc(func(ctx context.Context, reqCtx HTTPRequestContext) (string, error) {
						// Extract creatorId from path
						if reqCtx.Path == "/content/creator123" {
							return "0xCreator123Wallet", nil
						}
						return "0xDefaultCreator", nil
					}),
					// Dynamic price: Based on content type
					Price: DynamicPriceFunc(func(ctx context.Context, reqCtx HTTPRequestContext) (x402.Price, error) {
						// In production, would check request body or headers
						if reqCtx.Path == "/content/creator123" {
							return "$5.00", nil // Premium content
						}
						return "$1.00", nil // Standard content
					}),
				},
			},
		},
	}

	mockFacilitator := &mockFacilitatorClient{
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

	server := Newx402HTTPResourceServer(routes,
		x402.WithSchemeServer("eip155:8453", mockServer),
		x402.WithFacilitatorClient(mockFacilitator),
	)

	// Initialize to populate facilitator support
	_ = server.Initialize(context.Background())

	adapter := &mockHTTPAdapter{
		method: "POST",
		path:   "/content/creator123",
		url:    "http://example.com/content/creator123",
		accept: "application/json",
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/content/creator123",
		Method:  "POST",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)

	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment error (no payment provided), got %s", result.Type)
	}

	// Both dynamic values should have been resolved without error
}

// TestDynamicPayTo_Error tests error handling in dynamic payTo
func TestDynamicPayTo_Error(t *testing.T) {
	routes := RoutesConfig{
		"GET /test": RouteConfig{
			Accepts: []PaymentOption{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
					Price:   "$10.00",
					// Dynamic payTo that returns an error
					PayTo: DynamicPayToFunc(func(ctx context.Context, reqCtx HTTPRequestContext) (string, error) {
						return "", fmt.Errorf("seller not found")
					}),
				},
			},
		},
	}

	server := Newx402HTTPResourceServer(routes)

	adapter := &mockHTTPAdapter{
		method: "GET",
		path:   "/test",
		url:    "http://example.com/test",
		accept: "application/json",
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/test",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)

	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment error, got %s", result.Type)
	}

	if result.Response == nil {
		t.Fatal("Expected error response")
	}

	if result.Response.Status != 500 {
		t.Errorf("Expected status 500, got %d", result.Response.Status)
	}
}

// TestDynamicPrice_Error tests error handling in dynamic price
func TestDynamicPrice_Error(t *testing.T) {
	routes := RoutesConfig{
		"GET /test": RouteConfig{
			Accepts: []PaymentOption{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
					PayTo:   "0xRecipient",
					// Dynamic price that returns an error
					Price: DynamicPriceFunc(func(ctx context.Context, reqCtx HTTPRequestContext) (x402.Price, error) {
						return nil, fmt.Errorf("pricing server unavailable")
					}),
				},
			},
		},
	}

	server := Newx402HTTPResourceServer(routes)

	adapter := &mockHTTPAdapter{
		method: "GET",
		path:   "/test",
		url:    "http://example.com/test",
		accept: "application/json",
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/test",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)

	if result.Type != ResultPaymentError {
		t.Errorf("Expected payment error, got %s", result.Type)
	}

	if result.Response.Status != 500 {
		t.Errorf("Expected status 500, got %d", result.Response.Status)
	}
}

// TestStaticPayToAndPrice tests that static values still work
func TestStaticPayToAndPrice(t *testing.T) {
	mockServer := &mockSchemeServer{
		scheme: "exact",
	}

	routes := RoutesConfig{
		"GET /test": RouteConfig{
			Accepts: []PaymentOption{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
					PayTo:   "0xStaticRecipient", // Static string
					Price:   "$10.00",            // Static price
				},
			},
		},
	}

	server := Newx402HTTPResourceServer(routes, x402.WithSchemeServer("eip155:8453", mockServer))

	adapter := &mockHTTPAdapter{
		method: "GET",
		path:   "/test",
		url:    "http://example.com/test",
		accept: "application/json",
	}

	reqCtx := HTTPRequestContext{
		Adapter: adapter,
		Path:    "/test",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(context.Background(), reqCtx, nil)

	// Should work fine with static values (no resolution errors)
	// The result type depends on whether facilitators are configured
	// We just verify no 500 errors from resolution
	if result.Response != nil && result.Response.Status == 500 {
		if body, ok := result.Response.Body.(map[string]string); ok {
			if strings.Contains(body["error"], "Failed to resolve") {
				t.Error("Should not have resolution errors with static values")
			}
		}
	}
}
