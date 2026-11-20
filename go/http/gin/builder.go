package gin

import (
	"time"

	"github.com/gin-gonic/gin"
	x402 "github.com/x402-foundation/x402/go/v2"
	x402http "github.com/x402-foundation/x402/go/v2/http"
)

// Config provides struct-based configuration for x402 payment middleware.
// This is a cleaner alternative to the variadic options pattern.
type Config struct {
	// Routes maps HTTP patterns to payment requirements
	Routes x402http.RoutesConfig

	// Facilitator is a single facilitator client (most common case)
	// Use this OR Facilitators (not both)
	Facilitator x402.FacilitatorClient

	// Facilitators is an array of facilitator clients (for fallback/redundancy)
	// Use this OR Facilitator (not both)
	Facilitators []x402.FacilitatorClient

	// Schemes to register with the server
	Schemes []SchemeConfig

	// PaywallConfig for browser-based payment UI (optional)
	PaywallConfig *x402http.PaywallConfig

	// SyncFacilitatorOnStart fetches supported kinds from facilitators on startup
	// Default: true (leave nil). Set to a pointer to false to skip the startup fetch.
	//
	// A *bool is used because the zero value of a bool cannot express "not set": an explicit false
	// was previously indistinguishable from the default and was silently ignored.
	SyncFacilitatorOnStart *bool

	// Timeout for payment operations
	// Default: 30 seconds
	Timeout time.Duration

	// ErrorHandler for custom error handling (optional)
	ErrorHandler func(*gin.Context, error)

	// SettlementHandler called after successful settlement (optional)
	SettlementHandler func(*gin.Context, *x402.SettleResponse)
}

// syncDefaultTrue is a package-level value so internal wrappers can set the pointer field without a
// local variable. Callers who want an explicit true/false can use spb(true) / spb(false).
var syncDefaultTrue = true

// spb returns a pointer to b, for the SyncFacilitatorOnStart field.
func spb(b bool) *bool { return &b }

// SchemeConfig configures a payment scheme for a network.
type SchemeConfig struct {
	Network x402.Network
	Server  x402.SchemeNetworkServer
}

// X402Payment creates payment middleware using struct-based configuration.
// This is a cleaner, more readable alternative to PaymentMiddleware with variadic options.
//
// Args:
//
//	config: Payment middleware configuration
//
// Returns:
//
//	Gin middleware handler
//
// Example:
//
//	r.Use(ginmw.X402Payment(ginmw.Config{
//	    Routes: routes,
//	    Facilitator: facilitatorClient,
//	    Schemes: []ginmw.SchemeConfig{
//	        {Network: "eip155:*", Server: evm.NewExactEvmServer()},
//	        {Network: "solana:*", Server: svm.NewExactEvmServer()},
//	    },
//	    SyncFacilitatorOnStart: true,
//	    Timeout: 30 * time.Second,
//	}))
func X402Payment(config Config) gin.HandlerFunc {
	// Set defaults
	if config.Timeout == 0 {
		config.Timeout = 30 * time.Second
	}

	// Default to sync when facilitators are configured, unless the caller said otherwise.
	//
	// nil means "unset" and keeps the documented default (sync when a facilitator exists). A non-nil
	// value is the caller's explicit choice and is honoured exactly — including false with a
	// facilitator configured, which the previous bool-based logic discarded.
	//
	// Do NOT fold this back into a test on config.Timeout: Timeout is defaulted above this block, so
	// such a test is unconditionally true.
	syncOnStart := config.Facilitator != nil || len(config.Facilitators) > 0
	if config.SyncFacilitatorOnStart != nil {
		syncOnStart = *config.SyncFacilitatorOnStart
	}

	// Normalize facilitators list
	var facilitators []x402.FacilitatorClient
	if config.Facilitator != nil {
		facilitators = append(facilitators, config.Facilitator)
	}
	facilitators = append(facilitators, config.Facilitators...)

	// Convert to middleware options
	opts := []MiddlewareOption{
		WithSyncFacilitatorOnStart(syncOnStart),
		WithTimeout(config.Timeout),
	}

	// Add facilitators
	for _, facilitator := range facilitators {
		opts = append(opts, WithFacilitatorClient(facilitator))
	}

	// Add schemes
	for _, scheme := range config.Schemes {
		opts = append(opts, WithScheme(scheme.Network, scheme.Server))
	}

	// Add optional handlers
	if config.PaywallConfig != nil {
		opts = append(opts, WithPaywallConfig(config.PaywallConfig))
	}
	if config.ErrorHandler != nil {
		opts = append(opts, WithErrorHandler(config.ErrorHandler))
	}
	if config.SettlementHandler != nil {
		opts = append(opts, WithSettlementHandler(config.SettlementHandler))
	}

	// Delegate to PaymentMiddlewareFromConfig (reuse all logic)
	return PaymentMiddlewareFromConfig(config.Routes, opts...)
}

// SimpleX402Payment creates middleware with minimal configuration.
// Uses a single route pattern and facilitator for the simplest possible setup.
//
// Args:
//
//	payTo: Payment recipient address
//	price: Payment amount (e.g., "$0.001")
//	network: Payment network
//	facilitatorURL: Facilitator server URL
//
// Returns:
//
//	Gin middleware handler
//
// Example:
//
//	r.Use(gin.SimpleX402Payment(
//	    "0x123...",
//	    "$0.001",
//	    "eip155:8453",
//	    "https://facilitator.example.com",
//	))
func SimpleX402Payment(payTo string, price string, network x402.Network, facilitatorURL string) gin.HandlerFunc {
	// Create facilitator client
	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

	// Create routes for all endpoints
	routes := x402http.RoutesConfig{
		"*": {
			Accepts: []x402http.PaymentOption{
				{
					Scheme:  "exact",
					PayTo:   payTo,
					Price:   x402.Price(price),
					Network: network,
				},
			},
		},
	}

	return X402Payment(Config{
		Routes:                 routes,
		Facilitator:            facilitator,
		SyncFacilitatorOnStart: &syncDefaultTrue,
	})
}
