package http

import (
	"strings"

	"github.com/coinbase/x402/go/types"
)

// ============================================================================
// Paywall Provider Interfaces
// ============================================================================

// PaywallProvider generates HTML for browser-facing 402 responses.
// Register a custom implementation via RegisterPaywallProvider to override
// the built-in EVM/SVM templates.
type PaywallProvider interface {
	GenerateHTML(paymentRequired types.PaymentRequired, config *PaywallConfig) string
}

// PaywallNetworkHandler handles paywall HTML generation for a specific network family.
// Used with PaywallBuilder to compose network-specific handlers into a single PaywallProvider.
type PaywallNetworkHandler interface {
	// Supports returns true if this handler can generate HTML for the given payment requirement.
	Supports(requirement types.PaymentRequirements) bool

	// GenerateHTML generates the paywall HTML for the given requirement.
	GenerateHTML(requirement types.PaymentRequirements, paymentRequired types.PaymentRequired, config *PaywallConfig) string
}

// ============================================================================
// Built-in Network Handlers
// ============================================================================

// EVMPaywallHandler generates paywall HTML for EVM-compatible networks (eip155:*).
type EVMPaywallHandler struct{}

// Supports returns true for EVM networks (eip155:* CAIP-2 identifiers).
func (h *EVMPaywallHandler) Supports(requirement types.PaymentRequirements) bool {
	return strings.HasPrefix(requirement.Network, "eip155:")
}

// GenerateHTML generates paywall HTML using the built-in EVM template.
func (h *EVMPaywallHandler) GenerateHTML(_ types.PaymentRequirements, paymentRequired types.PaymentRequired, config *PaywallConfig) string {
	return injectPaywallConfig(EVMPaywallTemplate, paymentRequired, config)
}

// SVMPaywallHandler generates paywall HTML for Solana networks (solana:*).
type SVMPaywallHandler struct{}

// Supports returns true for Solana networks (solana:* CAIP-2 identifiers).
func (h *SVMPaywallHandler) Supports(requirement types.PaymentRequirements) bool {
	return strings.HasPrefix(requirement.Network, "solana:")
}

// GenerateHTML generates paywall HTML using the built-in SVM template.
func (h *SVMPaywallHandler) GenerateHTML(_ types.PaymentRequirements, paymentRequired types.PaymentRequired, config *PaywallConfig) string {
	return injectPaywallConfig(SVMPaywallTemplate, paymentRequired, config)
}

// ============================================================================
// Paywall Builder
// ============================================================================

// PaywallBuilder composes multiple PaywallNetworkHandlers into a single PaywallProvider.
// Use NewPaywallBuilder to create a builder, add network handlers, and call Build.
type PaywallBuilder struct {
	handlers []PaywallNetworkHandler
	config   *PaywallConfig
}

// NewPaywallBuilder creates a new PaywallBuilder.
func NewPaywallBuilder() *PaywallBuilder {
	return &PaywallBuilder{}
}

// WithNetwork adds a network handler to the builder.
func (b *PaywallBuilder) WithNetwork(handler PaywallNetworkHandler) *PaywallBuilder {
	b.handlers = append(b.handlers, handler)
	return b
}

// WithConfig sets default paywall configuration for the builder.
func (b *PaywallBuilder) WithConfig(config *PaywallConfig) *PaywallBuilder {
	b.config = config
	return b
}

// Build creates a PaywallProvider that dispatches to the first matching network handler.
func (b *PaywallBuilder) Build() PaywallProvider {
	return &compositePaywallProvider{
		handlers: b.handlers,
		config:   b.config,
	}
}

// compositePaywallProvider dispatches to the first handler that supports the payment requirement.
type compositePaywallProvider struct {
	handlers []PaywallNetworkHandler
	config   *PaywallConfig
}

func (p *compositePaywallProvider) GenerateHTML(paymentRequired types.PaymentRequired, config *PaywallConfig) string {
	// Use builder config as fallback if no per-call config provided
	effectiveConfig := config
	if effectiveConfig == nil {
		effectiveConfig = p.config
	}

	for _, req := range paymentRequired.Accepts {
		for _, handler := range p.handlers {
			if handler.Supports(req) {
				return handler.GenerateHTML(req, paymentRequired, effectiveConfig)
			}
		}
	}

	return ""
}

// DefaultPaywallProvider creates a PaywallProvider with built-in EVM and SVM handlers.
func DefaultPaywallProvider() PaywallProvider {
	return NewPaywallBuilder().
		WithNetwork(&EVMPaywallHandler{}).
		WithNetwork(&SVMPaywallHandler{}).
		Build()
}
