// Package http provides HTTP-specific implementations of x402 components.
// This includes HTTP-aware clients, services, and facilitator clients.
package http

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// ============================================================================
// Re-export main types for convenience
// ============================================================================

// HTTP Client types
type (
	// HTTPClient is an alias for x402HTTPClient
	HTTPClient = x402HTTPClient

	// HTTPServer is an alias for x402HTTPResourceServer
	HTTPServer = x402HTTPResourceServer
)

// ============================================================================
// Constructor functions with simpler names
// ============================================================================

// NewClient creates a new HTTP-aware x402 client
func NewClient(client *x402.X402Client) *x402HTTPClient {
	return Newx402HTTPClient(client)
}

// NewServer creates a new HTTP resource server
func NewServer(routes RoutesConfig, opts ...x402.ResourceServerOption) *x402HTTPResourceServer {
	return Newx402HTTPResourceServer(routes, opts...)
}

// NewFacilitatorClient creates a new HTTP facilitator client
func NewFacilitatorClient(config *FacilitatorConfig) *HTTPFacilitatorClient {
	return NewHTTPFacilitatorClient(config)
}

// ============================================================================
// Convenience functions
// ============================================================================

// WrapClient wraps a standard HTTP client with x402 payment handling
func WrapClient(client *http.Client, x402Client *x402HTTPClient) *http.Client {
	return WrapHTTPClientWithPayment(client, x402Client)
}

// Get performs a GET request with automatic payment handling
func Get(ctx context.Context, url string, x402Client *x402HTTPClient) (*http.Response, error) {
	return x402Client.GetWithPayment(ctx, url)
}

// Post performs a POST request with automatic payment handling
func Post(ctx context.Context, url string, body io.Reader, x402Client *x402HTTPClient) (*http.Response, error) {
	return x402Client.PostWithPayment(ctx, url, body)
}

// Do performs an HTTP request with automatic payment handling
func Do(ctx context.Context, req *http.Request, x402Client *x402HTTPClient) (*http.Response, error) {
	return x402Client.DoWithPayment(ctx, req)
}

// ============================================================================
// Response body limits
// ============================================================================

// ErrResponseBodyTooLarge indicates that an HTTP response body exceeded the
// buffering limit applied by x402 clients.
var ErrResponseBodyTooLarge = errors.New("http response body too large")

// maxControlPlaneResponseBytes bounds the payment-required and facilitator
// responses buffered by this package. Control-plane JSON is small, so a tight
// limit is enough.
const maxControlPlaneResponseBytes int64 = 1 << 20

// readLimitedBody reads at most maxControlPlaneResponseBytes from r. A larger
// body returns ErrResponseBodyTooLarge without buffering the rest.
func readLimitedBody(r io.Reader) ([]byte, error) {
	body, err := io.ReadAll(io.LimitReader(r, maxControlPlaneResponseBytes+1))
	if err != nil {
		return nil, err
	}
	if int64(len(body)) > maxControlPlaneResponseBytes {
		return nil, fmt.Errorf("%w: limit %d bytes", ErrResponseBodyTooLarge, maxControlPlaneResponseBytes)
	}
	return body, nil
}
