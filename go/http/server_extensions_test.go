// package http_test is an external test package. External test packages may import packages
// that import the package under test (go/http), which is the only way to break the otherwise
// circular dependency: go/http → bazaar → go/http.
package http_test

import (
	"context"
	"testing"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/bazaar"
	"github.com/x402-foundation/x402/go/extensions/eip2612gassponsor"
	"github.com/x402-foundation/x402/go/extensions/paymentidentifier"
	gohttp "github.com/x402-foundation/x402/go/http"
	"github.com/x402-foundation/x402/go/types"
)

// extTestHTTPAdapter is a minimal HTTPAdapter for use in this external test package.
type extTestHTTPAdapter struct {
	headers map[string]string
	method  string
	path    string
	url     string
	accept  string
	agent   string
}

func (m *extTestHTTPAdapter) GetHeader(name string) string {
	if m.headers == nil {
		return ""
	}
	return m.headers[name]
}
func (m *extTestHTTPAdapter) GetMethod() string       { return m.method }
func (m *extTestHTTPAdapter) GetPath() string         { return m.path }
func (m *extTestHTTPAdapter) GetURL() string          { return m.url }
func (m *extTestHTTPAdapter) GetAcceptHeader() string { return m.accept }
func (m *extTestHTTPAdapter) GetUserAgent() string    { return m.agent }

// extTestSchemeServer is a minimal SchemeServer mock.
type extTestSchemeServer struct{ scheme string }

func (m *extTestSchemeServer) Scheme() string { return m.scheme }
func (m *extTestSchemeServer) ParsePrice(_ x402.Price, _ x402.Network) (x402.AssetAmount, error) {
	return x402.AssetAmount{Asset: "USDC", Amount: "1000000"}, nil
}
func (m *extTestSchemeServer) EnhancePaymentRequirements(_ context.Context, base types.PaymentRequirements, _ types.SupportedKind, _ []string) (types.PaymentRequirements, error) {
	return base, nil
}

// extTestFacilitatorClient is a minimal FacilitatorClient mock.
type extTestFacilitatorClient struct {
	supported func(context.Context) (x402.SupportedResponse, error)
}

func (m *extTestFacilitatorClient) Verify(_ context.Context, _, _ []byte) (*x402.VerifyResponse, error) {
	return &x402.VerifyResponse{IsValid: true, Payer: "0xmock"}, nil
}
func (m *extTestFacilitatorClient) Settle(_ context.Context, _, _ []byte) (*x402.SettleResponse, error) {
	return &x402.SettleResponse{Success: true, Transaction: "0xmock", Network: "eip155:1", Payer: "0xmock"}, nil
}
func (m *extTestFacilitatorClient) GetSupported(ctx context.Context) (x402.SupportedResponse, error) {
	if m.supported != nil {
		return m.supported(ctx)
	}
	return x402.SupportedResponse{
		Kinds:      []x402.SupportedKind{{X402Version: 2, Scheme: "exact", Network: "eip155:1"}},
		Extensions: []string{},
		Signers:    make(map[string][]string),
	}, nil
}
func (m *extTestFacilitatorClient) Identifier() string { return "mock" }

// TestProcessHTTPRequestWithExtensions is a regression test for the EnrichExtensions
// activation. Before this PR, the EnrichExtensions call in ProcessHTTPRequest was disabled
// (commented out). This test verifies that routes with bazaar discovery extensions configured
// still return correct 402 responses after activating the enrichment path.
//
// This test lives in package http_test (external) rather than package http so that it can
// import go/extensions/bazaar without creating an import cycle (bazaar → go/http → bazaar).
func TestProcessHTTPRequestWithExtensions(t *testing.T) {
	ctx := context.Background()

	bazaarDecl, err := bazaar.DeclareDiscoveryExtension(
		bazaar.MethodGET,
		map[string]interface{}{},
		bazaar.JSONSchema{"properties": map[string]interface{}{}},
		"",
		nil,
	)
	if err != nil {
		t.Fatalf("DeclareDiscoveryExtension: %v", err)
	}

	routes := gohttp.RoutesConfig{
		"GET /api/data": {
			Accepts: gohttp.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
			Description: "Data endpoint with bazaar extension",
			// Extensions are enriched at request time via EnrichExtensions,
			// which was previously disabled and is now active in this PR.
			Extensions: map[string]interface{}{
				bazaar.BAZAAR.Key(): bazaarDecl,
			},
		},
	}

	mockServer := &extTestSchemeServer{scheme: "exact"}
	mockClient := &extTestFacilitatorClient{
		supported: func(ctx context.Context) (x402.SupportedResponse, error) {
			return x402.SupportedResponse{
				Kinds:      []x402.SupportedKind{{X402Version: 2, Scheme: "exact", Network: "eip155:1"}},
				Extensions: []string{},
				Signers:    make(map[string][]string),
			}, nil
		},
	}

	server := gohttp.Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:1", mockServer),
	)
	_ = server.Initialize(ctx)

	adapter := &extTestHTTPAdapter{
		method: "GET",
		path:   "/api/data",
		url:    "http://example.com/api/data",
		accept: "application/json",
	}

	reqCtx := gohttp.HTTPRequestContext{
		Adapter: adapter,
		Path:    "/api/data",
		Method:  "GET",
	}

	// EnrichExtensions is now active — verify it does not break the 402 response path
	result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

	if result.Type != gohttp.ResultPaymentError {
		t.Errorf("Expected payment error, got %s", result.Type)
	}
	if result.Response == nil {
		t.Fatal("Expected response instructions")
	}
	if result.Response.Status != 402 {
		t.Errorf("Expected status 402, got %d", result.Response.Status)
	}
	if result.Response.Headers["PAYMENT-REQUIRED"] == "" {
		t.Error("Expected PAYMENT-REQUIRED header to be set after enrichment")
	}
}

// TestProcessHTTPRequestWithPaymentIdentifierExtension is a regression test confirming that
// EnrichExtensions activation does not break routes that declare the paymentidentifier extension.
// paymentidentifier.EnrichDeclaration is a no-op; this test ensures the declaration passes through
// unchanged and the 402 response is still produced correctly.
func TestProcessHTTPRequestWithPaymentIdentifierExtension(t *testing.T) {
	ctx := context.Background()

	piDecl := paymentidentifier.DeclarePaymentIdentifierExtension(false)

	routes := gohttp.RoutesConfig{
		"GET /api/data": {
			Accepts: gohttp.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
			Description: "Data endpoint with payment-identifier extension",
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: piDecl,
			},
		},
	}

	mockServer := &extTestSchemeServer{scheme: "exact"}
	mockClient := &extTestFacilitatorClient{}

	server := gohttp.Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:1", mockServer),
	)
	_ = server.Initialize(ctx)

	adapter := &extTestHTTPAdapter{
		method: "GET",
		path:   "/api/data",
		url:    "http://example.com/api/data",
		accept: "application/json",
	}

	reqCtx := gohttp.HTTPRequestContext{
		Adapter: adapter,
		Path:    "/api/data",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

	if result.Type != gohttp.ResultPaymentError {
		t.Errorf("Expected payment error, got %s", result.Type)
	}
	if result.Response == nil {
		t.Fatal("Expected response instructions")
	}
	if result.Response.Status != 402 {
		t.Errorf("Expected status 402, got %d", result.Response.Status)
	}
	if result.Response.Headers["PAYMENT-REQUIRED"] == "" {
		t.Error("Expected PAYMENT-REQUIRED header after paymentidentifier extension enrichment")
	}
}

// TestProcessHTTPRequestWithEip2612GasSponsorExtension is a regression test confirming that
// EnrichExtensions activation does not break routes that declare the eip2612gassponsor extension.
// The extension declaration passes through EnrichExtensions unchanged (no server-side enricher is
// registered for it), and the 402 response must still be produced correctly.
func TestProcessHTTPRequestWithEip2612GasSponsorExtension(t *testing.T) {
	ctx := context.Background()

	gasExt := eip2612gassponsor.DeclareEip2612GasSponsoringExtension()

	routes := gohttp.RoutesConfig{
		"GET /api/data": {
			Accepts: gohttp.PaymentOptions{
				{
					Scheme:  "exact",
					PayTo:   "0xtest",
					Price:   "$1.00",
					Network: "eip155:1",
				},
			},
			Description: "Data endpoint with eip2612gassponsor extension",
			Extensions:  gasExt,
		},
	}

	mockServer := &extTestSchemeServer{scheme: "exact"}
	mockClient := &extTestFacilitatorClient{}

	server := gohttp.Newx402HTTPResourceServer(
		routes,
		x402.WithFacilitatorClient(mockClient),
		x402.WithSchemeServer("eip155:1", mockServer),
	)
	_ = server.Initialize(ctx)

	adapter := &extTestHTTPAdapter{
		method: "GET",
		path:   "/api/data",
		url:    "http://example.com/api/data",
		accept: "application/json",
	}

	reqCtx := gohttp.HTTPRequestContext{
		Adapter: adapter,
		Path:    "/api/data",
		Method:  "GET",
	}

	result := server.ProcessHTTPRequest(ctx, reqCtx, nil)

	if result.Type != gohttp.ResultPaymentError {
		t.Errorf("Expected payment error, got %s", result.Type)
	}
	if result.Response == nil {
		t.Fatal("Expected response instructions")
	}
	if result.Response.Status != 402 {
		t.Errorf("Expected status 402, got %d", result.Response.Status)
	}
	if result.Response.Headers["PAYMENT-REQUIRED"] == "" {
		t.Error("Expected PAYMENT-REQUIRED header after eip2612gassponsor extension enrichment")
	}
}
