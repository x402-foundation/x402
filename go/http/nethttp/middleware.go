package nethttp

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/extensions/bazaar"
	x402http "github.com/coinbase/x402/go/http"
)

// SetSettlementOverrides sets settlement overrides on the response for partial settlement.
// The middleware extracts these before settlement and strips the header from the client response.
func SetSettlementOverrides(w http.ResponseWriter, overrides *x402.SettlementOverrides) {
	w.Header().Set(x402http.SettlementOverridesHeader, x402http.MarshalSettlementOverrides(overrides))
}

// ============================================================================
// Middleware Configuration
// ============================================================================

// MiddlewareConfig configures the payment middleware.
type MiddlewareConfig struct {
	// Routes configuration
	Routes x402http.RoutesConfig

	// Facilitator client(s)
	FacilitatorClients []x402.FacilitatorClient

	// Scheme registrations
	Schemes []SchemeRegistration

	// Paywall configuration
	PaywallConfig *x402http.PaywallConfig

	// Sync with facilitator on start
	SyncFacilitatorOnStart bool

	// Custom error handler
	ErrorHandler func(w http.ResponseWriter, r *http.Request, err error)

	// Custom settlement handler
	SettlementHandler func(w http.ResponseWriter, r *http.Request, resp *x402.SettleResponse)

	// Context timeout for payment operations
	Timeout time.Duration
}

// SchemeRegistration registers a scheme with the server.
type SchemeRegistration struct {
	Network x402.Network
	Server  x402.SchemeNetworkServer
}

// MiddlewareOption configures the middleware.
type MiddlewareOption func(*MiddlewareConfig)

// WithFacilitatorClient adds a facilitator client.
func WithFacilitatorClient(client x402.FacilitatorClient) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.FacilitatorClients = append(c.FacilitatorClients, client)
	}
}

// WithScheme registers a scheme server.
func WithScheme(network x402.Network, schemeServer x402.SchemeNetworkServer) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.Schemes = append(c.Schemes, SchemeRegistration{
			Network: network,
			Server:  schemeServer,
		})
	}
}

// WithPaywallConfig sets the paywall configuration.
func WithPaywallConfig(config *x402http.PaywallConfig) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.PaywallConfig = config
	}
}

// WithSyncFacilitatorOnStart sets whether to sync with facilitator on startup.
func WithSyncFacilitatorOnStart(sync bool) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.SyncFacilitatorOnStart = sync
	}
}

// WithErrorHandler sets a custom error handler.
func WithErrorHandler(handler func(w http.ResponseWriter, r *http.Request, err error)) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.ErrorHandler = handler
	}
}

// WithSettlementHandler sets a custom settlement handler.
func WithSettlementHandler(handler func(w http.ResponseWriter, r *http.Request, resp *x402.SettleResponse)) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.SettlementHandler = handler
	}
}

// WithTimeout sets the context timeout for payment operations.
func WithTimeout(timeout time.Duration) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.Timeout = timeout
	}
}

// ============================================================================
// Payment Middleware
// ============================================================================

// PaymentMiddleware creates net/http middleware for x402 payment handling using a pre-configured server.
func PaymentMiddleware(routes x402http.RoutesConfig, server *x402.X402ResourceServer, opts ...MiddlewareOption) func(http.Handler) http.Handler {
	config := &MiddlewareConfig{
		Routes:                 routes,
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}

	for _, opt := range opts {
		opt(config)
	}

	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, server)

	httpServer.RegisterExtension(bazaar.BazaarResourceServerExtension)

	if config.SyncFacilitatorOnStart {
		ctx, cancel := context.WithTimeout(context.Background(), config.Timeout)
		defer cancel()
		if err := httpServer.Initialize(ctx); err != nil {
			fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
		}
	}

	return createMiddlewareHandler(httpServer, config)
}

// PaymentMiddlewareFromConfig creates net/http middleware for x402 payment handling.
// This creates the server internally from the provided options.
func PaymentMiddlewareFromConfig(routes x402http.RoutesConfig, opts ...MiddlewareOption) func(http.Handler) http.Handler {
	config := &MiddlewareConfig{
		Routes:                 routes,
		FacilitatorClients:     []x402.FacilitatorClient{},
		Schemes:                []SchemeRegistration{},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}

	for _, opt := range opts {
		opt(config)
	}

	serverOpts := []x402.ResourceServerOption{}
	for _, client := range config.FacilitatorClients {
		serverOpts = append(serverOpts, x402.WithFacilitatorClient(client))
	}

	httpServer := x402http.Newx402HTTPResourceServer(config.Routes, serverOpts...)

	httpServer.RegisterExtension(bazaar.BazaarResourceServerExtension)

	for _, scheme := range config.Schemes {
		httpServer.Register(scheme.Network, scheme.Server)
	}

	if config.SyncFacilitatorOnStart {
		ctx, cancel := context.WithTimeout(context.Background(), config.Timeout)
		defer cancel()
		if err := httpServer.Initialize(ctx); err != nil {
			fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
		}
	}

	return createMiddlewareHandler(httpServer, config)
}

// PaymentMiddlewareFromHTTPServer creates net/http middleware using a pre-configured HTTPServer.
// This allows registering hooks (e.g., OnProtectedRequest) on the server before attaching to the router.
//
// Example:
//
//	resourceServer := x402.Newx402ResourceServer(
//	    x402.WithFacilitatorClient(facilitator),
//	).Register("eip155:*", evm.NewExactEvmScheme())
//
//	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, resourceServer).
//	    OnProtectedRequest(requestHook)
//
//	handler := nethttp.PaymentMiddlewareFromHTTPServer(httpServer)(mux)
func PaymentMiddlewareFromHTTPServer(httpServer *x402http.HTTPServer, opts ...MiddlewareOption) func(http.Handler) http.Handler {
	config := &MiddlewareConfig{
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}

	for _, opt := range opts {
		opt(config)
	}

	httpServer.RegisterExtension(bazaar.BazaarResourceServerExtension)

	if config.SyncFacilitatorOnStart {
		ctx, cancel := context.WithTimeout(context.Background(), config.Timeout)
		defer cancel()
		if err := httpServer.Initialize(ctx); err != nil {
			fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
		}
	}

	return createMiddlewareHandler(httpServer, config)
}

// createMiddlewareHandler creates the actual http.Handler middleware function.
func createMiddlewareHandler(server *x402http.HTTPServer, config *MiddlewareConfig) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			adapter := NewNetHTTPAdapter(r)
			reqCtx := x402http.HTTPRequestContext{
				Adapter: adapter,
				Path:    r.URL.Path,
				Method:  r.Method,
			}

			// Check if route requires payment
			if !server.RequiresPayment(reqCtx) {
				next.ServeHTTP(w, r)
				return
			}

			// Create context with timeout
			ctx, cancel := context.WithTimeout(r.Context(), config.Timeout)
			defer cancel()

			result := server.ProcessHTTPRequest(ctx, reqCtx, config.PaywallConfig)

			switch result.Type {
			case x402http.ResultNoPaymentRequired:
				next.ServeHTTP(w, r)

			case x402http.ResultPaymentError:
				handlePaymentError(w, result.Response)

			case x402http.ResultPaymentVerified:
				handlePaymentVerified(w, r, next, server, ctx, reqCtx, result, config)
			}
		})
	}
}

// handlePaymentError writes a payment error response (typically 402).
func handlePaymentError(w http.ResponseWriter, response *x402http.HTTPResponseInstructions) {
	for key, value := range response.Headers {
		w.Header().Set(key, value)
	}

	if response.IsHTML {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		w.WriteHeader(response.Status)
		fmt.Fprint(w, response.Body)
	} else {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(response.Status)
		_ = json.NewEncoder(w).Encode(response.Body)
	}
}

// handlePaymentVerified handles verified payments with response capture and settlement.
func handlePaymentVerified(w http.ResponseWriter, r *http.Request, next http.Handler, server *x402http.HTTPServer, ctx context.Context, reqCtx x402http.HTTPRequestContext, result x402http.HTTPProcessResult, config *MiddlewareConfig) {
	// Capture downstream handler response
	capture := &responseCapture{
		ResponseWriter: w,
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}

	// Set payment data in request context for downstream handlers
	if result.PaymentPayload != nil {
		r = r.WithContext(context.WithValue(r.Context(), payloadContextKey, result.PaymentPayload)) //nolint:contextcheck // context is derived from r.Context()
	}
	if result.PaymentRequirements != nil {
		r = r.WithContext(context.WithValue(r.Context(), requirementsContextKey, result.PaymentRequirements)) //nolint:contextcheck // context is derived from r.Context()
	}

	// Call downstream handler with captured writer
	next.ServeHTTP(capture, r)

	// Don't settle if response failed
	if capture.statusCode >= 400 {
		w.WriteHeader(capture.statusCode)
		_, _ = w.Write(capture.body.Bytes())
		return
	}

	settleResult := server.ProcessSettlement(
		ctx,
		*result.PaymentPayload,
		*result.PaymentRequirements,
		nil,
		&x402http.HTTPTransportContext{
			Request:         &reqCtx,
			ResponseBody:    capture.body.Bytes(),
			ResponseHeaders: capture.Header(),
		},
	)

	if !settleResult.Success {
		// Always set PAYMENT-RESPONSE header on settlement failure
		for key, value := range settleResult.Headers {
			w.Header().Set(key, value)
		}
		switch {
		case config.ErrorHandler != nil:
			errorReason := settleResult.ErrorReason
			if errorReason == "" {
				errorReason = "Settlement failed"
			}
			config.ErrorHandler(w, r, fmt.Errorf("settlement failed: %s", errorReason))
		case settleResult.Response != nil:
			handlePaymentError(w, settleResult.Response)
		default:
			w.Header().Set("Content-Type", "application/json")
			w.WriteHeader(http.StatusPaymentRequired)
			_ = json.NewEncoder(w).Encode(map[string]any{})
		}
		return
	}

	// Add settlement headers
	for key, value := range settleResult.Headers {
		w.Header().Set(key, value)
	}

	// Call settlement handler if configured
	if config.SettlementHandler != nil {
		settleResponse := &x402.SettleResponse{
			Success:     true,
			Transaction: settleResult.Transaction,
			Network:     settleResult.Network,
			Payer:       settleResult.Payer,
		}
		config.SettlementHandler(w, r, settleResponse)
	}

	// Write captured response
	w.WriteHeader(capture.statusCode)
	_, _ = w.Write(capture.body.Bytes())
}

// ============================================================================
// Response Capture
// ============================================================================

// responseCapture captures the response for settlement processing.
type responseCapture struct {
	http.ResponseWriter
	body       *bytes.Buffer
	statusCode int
	written    bool
	mu         sync.Mutex
}

// WriteHeader captures the status code without writing to the underlying writer.
func (w *responseCapture) WriteHeader(code int) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.written {
		w.statusCode = code
		w.written = true
	}
}

// Write captures the response body without writing to the underlying writer.
func (w *responseCapture) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.written {
		w.statusCode = http.StatusOK
		w.written = true
	}
	return w.body.Write(data)
}
