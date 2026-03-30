package echo

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"sync"
	"time"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/extensions/bazaar"
	x402http "github.com/coinbase/x402/go/http"
	"github.com/labstack/echo/v4"
)

// SetSettlementOverrides sets settlement overrides on the Echo response for partial settlement.
// The middleware extracts these before settlement and strips the header from the client response.
func SetSettlementOverrides(c echo.Context, overrides *x402.SettlementOverrides) {
	c.Response().Header().Set(x402http.SettlementOverridesHeader, x402http.MarshalSettlementOverrides(overrides))
}

// ============================================================================
// Echo Adapter Implementation
// ============================================================================

// EchoAdapter implements HTTPAdapter for Echo framework
type EchoAdapter struct {
	ctx echo.Context
}

// NewEchoAdapter creates a new Echo adapter
func NewEchoAdapter(ctx echo.Context) *EchoAdapter {
	return &EchoAdapter{ctx: ctx}
}

// GetHeader gets a request header
func (a *EchoAdapter) GetHeader(name string) string {
	return a.ctx.Request().Header.Get(name)
}

// GetMethod gets the HTTP method
func (a *EchoAdapter) GetMethod() string {
	return a.ctx.Request().Method
}

// GetPath gets the request path
func (a *EchoAdapter) GetPath() string {
	return a.ctx.Request().URL.Path
}

// GetURL gets the full request URL
func (a *EchoAdapter) GetURL() string {
	req := a.ctx.Request()
	scheme := "http"
	if req.TLS != nil {
		scheme = "https"
	}
	host := req.Host
	if host == "" {
		host = req.Header.Get("Host")
	}
	return fmt.Sprintf("%s://%s%s", scheme, host, req.RequestURI)
}

// GetAcceptHeader gets the Accept header
func (a *EchoAdapter) GetAcceptHeader() string {
	return a.ctx.Request().Header.Get("Accept")
}

// GetUserAgent gets the User-Agent header
func (a *EchoAdapter) GetUserAgent() string {
	return a.ctx.Request().Header.Get("User-Agent")
}

// ============================================================================
// Middleware Configuration
// ============================================================================

// MiddlewareConfig configures the payment middleware
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
	ErrorHandler func(echo.Context, error)

	// Custom settlement handler
	SettlementHandler func(echo.Context, *x402.SettleResponse)

	// Context timeout for payment operations
	Timeout time.Duration
}

// SchemeRegistration registers a scheme with the server
type SchemeRegistration struct {
	Network x402.Network
	Server  x402.SchemeNetworkServer
}

// MiddlewareOption configures the middleware
type MiddlewareOption func(*MiddlewareConfig)

// WithFacilitatorClient adds a facilitator client
func WithFacilitatorClient(client x402.FacilitatorClient) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.FacilitatorClients = append(c.FacilitatorClients, client)
	}
}

// WithScheme registers a scheme server
func WithScheme(network x402.Network, schemeServer x402.SchemeNetworkServer) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.Schemes = append(c.Schemes, SchemeRegistration{
			Network: network,
			Server:  schemeServer,
		})
	}
}

// WithPaywallConfig sets the paywall configuration
func WithPaywallConfig(config *x402http.PaywallConfig) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.PaywallConfig = config
	}
}

// WithSyncFacilitatorOnStart sets whether to sync with facilitator on startup
func WithSyncFacilitatorOnStart(sync bool) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.SyncFacilitatorOnStart = sync
	}
}

// WithErrorHandler sets a custom error handler
func WithErrorHandler(handler func(echo.Context, error)) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.ErrorHandler = handler
	}
}

// WithSettlementHandler sets a custom settlement handler
func WithSettlementHandler(handler func(echo.Context, *x402.SettleResponse)) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.SettlementHandler = handler
	}
}

// WithTimeout sets the context timeout for payment operations
func WithTimeout(timeout time.Duration) MiddlewareOption {
	return func(c *MiddlewareConfig) {
		c.Timeout = timeout
	}
}

// ============================================================================
// Payment Middleware
// ============================================================================

// PaymentMiddleware creates Echo middleware for x402 payment handling using a pre-configured server.
func PaymentMiddleware(routes x402http.RoutesConfig, server *x402.X402ResourceServer, opts ...MiddlewareOption) echo.MiddlewareFunc {
	config := &MiddlewareConfig{
		Routes:                 routes,
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}

	// Apply options
	for _, opt := range opts {
		opt(config)
	}

	// Wrap the resource server with HTTP functionality
	httpServer := x402http.Wrappedx402HTTPResourceServer(routes, server)

	httpServer.RegisterExtension(bazaar.BazaarResourceServerExtension)

	// Initialize if requested - queries facilitator /supported to populate facilitatorClients map
	if config.SyncFacilitatorOnStart {
		ctx, cancel := context.WithTimeout(context.Background(), config.Timeout)
		defer cancel()
		if err := httpServer.Initialize(ctx); err != nil {
			fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
		}
	}

	// Create middleware handler using shared logic
	return createMiddlewareHandler(httpServer, config)
}

// PaymentMiddlewareFromHTTPServer creates Echo middleware using a pre-configured HTTPServer.
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
//	e.Use(echomw.PaymentMiddlewareFromHTTPServer(httpServer))
func PaymentMiddlewareFromHTTPServer(httpServer *x402http.HTTPServer, opts ...MiddlewareOption) echo.MiddlewareFunc {
	config := &MiddlewareConfig{
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}

	// Apply options
	for _, opt := range opts {
		opt(config)
	}

	httpServer.RegisterExtension(bazaar.BazaarResourceServerExtension)

	// Initialize if requested - queries facilitator /supported to populate facilitatorClients map
	if config.SyncFacilitatorOnStart {
		ctx, cancel := context.WithTimeout(context.Background(), config.Timeout)
		defer cancel()
		if err := httpServer.Initialize(ctx); err != nil {
			fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
		}
	}

	// Create middleware handler using shared logic
	return createMiddlewareHandler(httpServer, config)
}

// PaymentMiddlewareFromConfig creates Echo middleware for x402 payment handling.
// This creates the server internally from the provided options.
func PaymentMiddlewareFromConfig(routes x402http.RoutesConfig, opts ...MiddlewareOption) echo.MiddlewareFunc {
	config := &MiddlewareConfig{
		Routes:                 routes,
		FacilitatorClients:     []x402.FacilitatorClient{},
		Schemes:                []SchemeRegistration{},
		SyncFacilitatorOnStart: true,
		Timeout:                30 * time.Second,
	}

	// Apply options
	for _, opt := range opts {
		opt(config)
	}

	serverOpts := []x402.ResourceServerOption{}
	for _, client := range config.FacilitatorClients {
		serverOpts = append(serverOpts, x402.WithFacilitatorClient(client))
	}

	httpServer := x402http.Newx402HTTPResourceServer(config.Routes, serverOpts...)

	httpServer.RegisterExtension(bazaar.BazaarResourceServerExtension)

	// Register schemes
	for _, scheme := range config.Schemes {
		httpServer.Register(scheme.Network, scheme.Server)
	}

	// Initialize if requested - queries facilitator /supported to populate facilitatorClients map
	if config.SyncFacilitatorOnStart {
		ctx, cancel := context.WithTimeout(context.Background(), config.Timeout)
		defer cancel()
		if err := httpServer.Initialize(ctx); err != nil {
			fmt.Printf("Warning: failed to initialize x402 server: %v\n", err)
		}
	}

	// Create middleware handler
	return createMiddlewareHandler(httpServer, config)
}

// createMiddlewareHandler creates the actual Echo middleware function.
func createMiddlewareHandler(server *x402http.HTTPServer, config *MiddlewareConfig) echo.MiddlewareFunc {
	return func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c echo.Context) error {
			// Create adapter and request context
			adapter := NewEchoAdapter(c)
			reqCtx := x402http.HTTPRequestContext{
				Adapter: adapter,
				Path:    c.Request().URL.Path,
				Method:  c.Request().Method,
			}

			// Check if route requires payment before waiting for initialization
			if !server.RequiresPayment(reqCtx) {
				return next(c)
			}

			// Create context with timeout
			ctx, cancel := context.WithTimeout(c.Request().Context(), config.Timeout)
			defer cancel()

			result := server.ProcessHTTPRequest(ctx, reqCtx, config.PaywallConfig)

			// Handle result
			switch result.Type {
			case x402http.ResultNoPaymentRequired:
				// No payment required, continue to next handler
				return next(c)

			case x402http.ResultPaymentError:
				// Payment required but not provided or invalid
				return handlePaymentError(c, result.Response)

			case x402http.ResultPaymentVerified:
				// Payment verified, continue with settlement handling
				return handlePaymentVerified(c, next, server, ctx, reqCtx, result, config)

			default:
				return next(c)
			}
		}
	}
}

// handlePaymentError handles payment error responses
func handlePaymentError(c echo.Context, response *x402http.HTTPResponseInstructions) error {
	// Set headers
	for key, value := range response.Headers {
		c.Response().Header().Set(key, value)
	}

	// Send response body
	if response.IsHTML {
		return c.HTMLBlob(response.Status, []byte(response.Body.(string)))
	}
	return c.JSON(response.Status, response.Body)
}

// handlePaymentVerified handles verified payments with settlement
func handlePaymentVerified(c echo.Context, next echo.HandlerFunc, server *x402http.HTTPServer, ctx context.Context, reqCtx x402http.HTTPRequestContext, result x402http.HTTPProcessResult, config *MiddlewareConfig) error {
	// Capture response for settlement
	origWriter := c.Response().Writer
	capture := &responseCapture{
		ResponseWriter: origWriter,
		body:           &bytes.Buffer{},
		statusCode:     http.StatusOK,
	}
	c.Response().Writer = capture

	// Set payment data in context for downstream handlers
	if result.PaymentPayload != nil {
		c.Set("x402_payload", *result.PaymentPayload)
	}
	if result.PaymentRequirements != nil {
		c.Set("x402_requirements", *result.PaymentRequirements)
	}

	// Continue to protected handler
	err := next(c)

	// Restore original writer
	c.Response().Writer = origWriter
	c.Response().Committed = false

	// If handler returned error, propagate it
	if err != nil {
		return err
	}

	// Don't settle if response failed
	if capture.statusCode >= 400 {
		// Write captured error response
		origWriter.WriteHeader(capture.statusCode)
		_, _ = origWriter.Write(capture.body.Bytes())
		return nil
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

	// Check settlement success
	if !settleResult.Success {
		// Always set PAYMENT-RESPONSE header on settlement failure
		for key, value := range settleResult.Headers {
			origWriter.Header().Set(key, value)
		}
		switch {
		case config.ErrorHandler != nil:
			errorReason := settleResult.ErrorReason
			if errorReason == "" {
				errorReason = "Settlement failed"
			}
			config.ErrorHandler(c, fmt.Errorf("settlement failed: %s", errorReason))
		case settleResult.Response != nil:
			return handlePaymentError(c, settleResult.Response)
		default:
			return c.JSON(http.StatusPaymentRequired, map[string]interface{}{})
		}
		return nil
	}

	// Add settlement headers
	for key, value := range settleResult.Headers {
		origWriter.Header().Set(key, value)
	}

	// Call settlement handler if configured
	if config.SettlementHandler != nil {
		settleResponse := &x402.SettleResponse{
			Success:     true,
			Transaction: settleResult.Transaction,
			Network:     settleResult.Network,
			Payer:       settleResult.Payer,
		}
		config.SettlementHandler(c, settleResponse)
	}

	// Write captured response
	origWriter.WriteHeader(capture.statusCode)
	_, _ = origWriter.Write(capture.body.Bytes())
	return nil
}

// ============================================================================
// Response Capture
// ============================================================================

// responseCapture captures the response for settlement processing
type responseCapture struct {
	http.ResponseWriter
	body       *bytes.Buffer
	statusCode int
	written    bool
	mu         sync.Mutex
}

// WriteHeader captures the status code
func (w *responseCapture) WriteHeader(code int) {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.writeHeaderLocked(code)
}

// writeHeaderLocked sets the status code (must be called with lock held)
func (w *responseCapture) writeHeaderLocked(code int) {
	if !w.written {
		w.statusCode = code
		w.written = true
	}
}

// Write captures the response body
func (w *responseCapture) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()

	if !w.written {
		w.writeHeaderLocked(http.StatusOK)
	}
	return w.body.Write(data)
}

// WriteString captures string responses
func (w *responseCapture) WriteString(s string) (int, error) {
	return w.Write([]byte(s))
}

// Flush is a no-op to prevent premature flushing to the wire before settlement.
func (w *responseCapture) Flush() {}
