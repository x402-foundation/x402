package x402

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/coinbase/x402/go/types"
)

// Network represents a blockchain network identifier in CAIP-2 format
// Format: namespace:reference (e.g., "eip155:1" for Ethereum mainnet)
type Network string

// Parse splits the network into namespace and reference components
func (n Network) Parse() (namespace, reference string, err error) {
	parts := strings.Split(string(n), ":")
	if len(parts) != 2 {
		return "", "", fmt.Errorf("invalid network format: %s", n)
	}
	return parts[0], parts[1], nil
}

// Match checks if this network matches a pattern (supports wildcards)
// e.g., "eip155:1" matches "eip155:*" and "eip155:*" matches "eip155:1"
func (n Network) Match(pattern Network) bool {
	if n == pattern {
		return true
	}

	nStr := string(n)
	patternStr := string(pattern)

	// Check if pattern has wildcard
	if strings.HasSuffix(patternStr, ":*") {
		prefix := strings.TrimSuffix(patternStr, "*")
		return strings.HasPrefix(nStr, prefix)
	}

	// Check if n has wildcard (for bidirectional matching)
	if strings.HasSuffix(nStr, ":*") {
		prefix := strings.TrimSuffix(nStr, "*")
		return strings.HasPrefix(patternStr, prefix)
	}

	return false
}

// Price represents a price that can be specified in various formats
type Price interface{}

// AssetAmount represents an amount of a specific asset
type AssetAmount struct {
	Asset  string                 `json:"asset"`
	Amount string                 `json:"amount"`
	Extra  map[string]interface{} `json:"extra,omitempty"`
}

// PartialPaymentPayload contains only x402Version for version detection
// Used to detect protocol version before unmarshaling to specific types
type PartialPaymentPayload struct {
	X402Version int `json:"x402Version"`
}

// Re-export V2 types as default in x402 package
// V2 types are defined in types/v2.go but re-exported here for convenience
type (
	PaymentRequirements = types.PaymentRequirements
	PaymentPayload      = types.PaymentPayload
	PaymentRequired     = types.PaymentRequired
	ResourceInfo        = types.ResourceInfo
	SupportedKind       = types.SupportedKind
	SupportedResponse   = types.SupportedResponse
)

// Re-export V1 types for legacy facilitator support
type (
	SupportedResponseV1 = types.SupportedResponseV1
)

// VerifyResponse contains the verification result
// If verification fails, an error (typically *VerifyError) is returned and this will be nil
type VerifyResponse struct {
	IsValid        bool   `json:"isValid"`
	InvalidReason  string `json:"invalidReason,omitempty"`
	InvalidMessage string `json:"invalidMessage,omitempty"`
	Payer          string `json:"payer,omitempty"`
}

// SettleResponse contains the settlement result
// If settlement fails, an error (typically *SettleError) is returned and this will be nil
type SettleResponse struct {
	Success      bool    `json:"success"`
	ErrorReason  string  `json:"errorReason,omitempty"`
	ErrorMessage string  `json:"errorMessage,omitempty"`
	Payer        string  `json:"payer,omitempty"`
	Transaction  string  `json:"transaction"`
	Network      Network `json:"network"`
	Amount       string  `json:"amount,omitempty"`
}

// SettlementOverrides allows overriding settlement parameters.
// Used to support partial settlement (e.g., upto scheme billing by actual usage).
type SettlementOverrides struct {
	// Amount to settle. Supports three formats:
	//   - Raw atomic units: "1000" settles exactly 1000 atomic units.
	//   - Percent: "50%" settles 50% of PaymentRequirements.Amount (up to 2 decimal places, floored).
	//   - Dollar price: "$0.05" converts to atomic units using Extra["decimals"] (default 6).
	// The resolved amount must be <= the authorized maximum in PaymentRequirements.
	Amount string `json:"amount,omitempty"`
}

// ResourceConfig defines payment configuration for a protected resource
type ResourceConfig struct {
	Scheme            string                 `json:"scheme"`
	PayTo             string                 `json:"payTo"`
	Price             Price                  `json:"price"`
	Network           Network                `json:"network"`
	MaxTimeoutSeconds int                    `json:"maxTimeoutSeconds,omitempty"`
	Extra             map[string]interface{} `json:"extra,omitempty"`
}

// ============================================================================
// View Interfaces for Selectors/Policies/Hooks
// ============================================================================

// PaymentRequirementsView is a unified interface for payment requirements
// Both V1 and V2 types implement this to work with selectors/policies/hooks
type PaymentRequirementsView interface {
	GetScheme() string
	GetNetwork() string // Returns network as string (can be converted to Network type)
	GetAsset() string
	GetAmount() string // V1: MaxAmountRequired, V2: Amount
	GetPayTo() string
	GetMaxTimeoutSeconds() int
	GetExtra() map[string]interface{}
}

// PaymentPayloadView is a unified interface for payment payloads
// Both V1 and V2 types implement this to work with hooks
type PaymentPayloadView interface {
	GetVersion() int
	GetScheme() string
	GetNetwork() string // Returns network as string (can be converted to Network type)
	GetPayload() map[string]interface{}
}

// PaymentRequirementsSelector chooses which payment option to use
// Works with unified view interface
type PaymentRequirementsSelector func(requirements []PaymentRequirementsView) PaymentRequirementsView

// PaymentPolicy filters or transforms payment requirements
// Works with unified view interface
type PaymentPolicy func(requirements []PaymentRequirementsView) []PaymentRequirementsView

// DefaultPaymentSelector chooses the first available payment option
func DefaultPaymentSelector(requirements []PaymentRequirementsView) PaymentRequirementsView {
	if len(requirements) == 0 {
		panic("no payment requirements available")
	}
	return requirements[0]
}

// ============================================================================
// Utility Functions
// ============================================================================

// DeepEqual performs deep equality check on payment requirements
func DeepEqual(a, b interface{}) bool {
	// Normalize to JSON and compare
	aJSON, err := json.Marshal(a)
	if err != nil {
		return false
	}
	bJSON, err := json.Marshal(b)
	if err != nil {
		return false
	}

	var aNorm, bNorm interface{}
	if err := json.Unmarshal(aJSON, &aNorm); err != nil {
		return false
	}
	if err := json.Unmarshal(bJSON, &bNorm); err != nil {
		return false
	}

	aNormJSON, _ := json.Marshal(aNorm)
	bNormJSON, _ := json.Marshal(bNorm)

	return string(aNormJSON) == string(bNormJSON)
}

// ParseNetwork parses a network string into Network type
func ParseNetwork(s string) Network {
	return Network(s)
}

// IsWildcardNetwork checks if network is a wildcard pattern
func IsWildcardNetwork(network Network) bool {
	return strings.HasSuffix(string(network), ":*")
}

// MatchesNetwork checks if a network matches a pattern (supports wildcards)
func MatchesNetwork(pattern Network, network Network) bool {
	if pattern == network {
		return true
	}
	if IsWildcardNetwork(pattern) {
		prefix := strings.TrimSuffix(string(pattern), "*")
		return strings.HasPrefix(string(network), prefix)
	}
	return false
}

// ============================================================================
// Helper Functions for View Conversion
// ============================================================================

// toViews converts a slice of concrete types to view interfaces
func toViews[T PaymentRequirementsView](reqs []T) []PaymentRequirementsView {
	views := make([]PaymentRequirementsView, len(reqs))
	for i, req := range reqs {
		views[i] = req
	}
	return views
}

// fromView converts a view interface back to concrete type
func fromView[T PaymentRequirementsView](view PaymentRequirementsView) T {
	return view.(T)
}
