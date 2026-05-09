package nethttp

import (
	"net/http"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	x402http "github.com/x402-foundation/x402/go/http"
)

// Config provides struct-based configuration for x402 payment middleware.
// This is a cleaner alternative to the variadic options pattern.
type Config struct {
	// Routes maps HTTP patterns to payment requirements.
	Routes x402http.RoutesConfig

	// Facilitator is a single facilitator client (most common case).
	// Use this OR Facilitators (not both).
	Facilitator x402.FacilitatorClient

	// Facilitators is an array of facilitator clients (for fallback/redundancy).
	// Use this OR Facilitator (not both).
	Facilitators []x402.FacilitatorClient

	// Schemes to register with the server.
	Schemes []SchemeConfig

	// PaywallConfig for browser-based payment UI (optional).
	PaywallConfig *x402http.PaywallConfig

	// SyncFacilitatorOnStart fetches supported kinds from facilitators on startup.
	// Default: true
	SyncFacilitatorOnStart bool

	// Timeout for payment operations.
	// Default: 30 seconds
	Timeout time.Duration

	// ErrorHandler for custom error handling (optional).
	ErrorHandler func(w http.ResponseWriter, r *http.Request, err error)

	// SettlementHandler called after successful settlement (optional).
	SettlementHandler func(w http.ResponseWriter, r *http.Request, resp *x402.SettleResponse)
}

// SchemeConfig configures a payment scheme for a network.
type SchemeConfig struct {
	Network x402.Network
	Server  x402.SchemeNetworkServer
}

// X402Payment creates payment middleware using struct-based configuration.
// This is a cleaner, more readable alternative to PaymentMiddlewareFromConfig with variadic options.
//
// Example:
//
//	mux := http.NewServeMux()
//	handler := nethttp.X402Payment(nethttp.Config{
//	    Routes: routes,
//	    Facilitator: facilitatorClient,
//	    Schemes: []nethttp.SchemeConfig{
//	        {Network: "eip155:*", Server: evm.NewExactEvmServer()},
//	    },
//	    SyncFacilitatorOnStart: true,
//	    Timeout: 30 * time.Second,
//	})(mux)
func X402Payment(config Config) func(http.Handler) http.Handler {
	if config.Timeout == 0 {
		config.Timeout = 30 * time.Second
	}

	// Default to sync when facilitators provided
	syncOnStart := config.SyncFacilitatorOnStart
	if !syncOnStart && config.Facilitator == nil && len(config.Facilitators) == 0 {
		syncOnStart = false
	} else if config.Facilitator != nil || len(config.Facilitators) > 0 {
		if config.Timeout != 0 {
			syncOnStart = true
		}
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

	for _, facilitator := range facilitators {
		opts = append(opts, WithFacilitatorClient(facilitator))
	}

	for _, scheme := range config.Schemes {
		opts = append(opts, WithScheme(scheme.Network, scheme.Server))
	}

	if config.PaywallConfig != nil {
		opts = append(opts, WithPaywallConfig(config.PaywallConfig))
	}
	if config.ErrorHandler != nil {
		opts = append(opts, WithErrorHandler(config.ErrorHandler))
	}
	if config.SettlementHandler != nil {
		opts = append(opts, WithSettlementHandler(config.SettlementHandler))
	}

	return PaymentMiddlewareFromConfig(config.Routes, opts...)
}

// SimpleX402Payment creates middleware with minimal configuration.
// Uses a single route pattern and facilitator for the simplest possible setup.
//
// Example:
//
//	mux := http.NewServeMux()
//	handler := nethttp.SimpleX402Payment(
//	    "0x123...",
//	    "$0.001",
//	    "eip155:8453",
//	    "https://facilitator.example.com",
//	)(mux)
func SimpleX402Payment(payTo string, price string, network x402.Network, facilitatorURL string) func(http.Handler) http.Handler {
	facilitator := x402http.NewHTTPFacilitatorClient(&x402http.FacilitatorConfig{
		URL: facilitatorURL,
	})

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
		SyncFacilitatorOnStart: true,
	})
}
