package x402

import "fmt"

// ValidatePaymentPayload performs basic validation on a payment payload
// Version-aware: handles both v1 and v2 payload structures
func ValidatePaymentPayload(p PaymentPayload) error {
	if p.X402Version < 1 || p.X402Version > 2 {
		return fmt.Errorf("unsupported x402 version: %d", p.X402Version)
	}

	// V2 validation: check accepted field
	if p.X402Version == 2 {
		if p.Accepted.Scheme == "" {
			return fmt.Errorf("payment scheme is required")
		}
		if p.Accepted.Network == "" {
			return fmt.Errorf("payment network is required")
		}
	}

	// Both v1 and v2 must have payload
	if p.Payload == nil {
		return fmt.Errorf("payment payload is required")
	}

	// Note: v1 validation is minimal here - scheme/network are validated
	// by the mechanism-specific facilitator based on the payment requirements
	return nil
}

// ValidatePaymentRequirements performs basic validation on payment requirements
func ValidatePaymentRequirements(r PaymentRequirements) error {
	if r.Scheme == "" {
		return fmt.Errorf("payment scheme is required")
	}
	if r.Network == "" {
		return fmt.Errorf("payment network is required")
	}
	if r.Asset == "" {
		return fmt.Errorf("payment asset is required")
	}
	// Note: Amount check is skipped for v1 compatibility (v1 uses maxAmountRequired)
	// Version-specific facilitators will validate amount fields as needed
	if r.PayTo == "" {
		return fmt.Errorf("payment recipient is required")
	}
	return nil
}

// findByNetworkAndScheme finds a scheme implementation for a given network/scheme combination
// This supports pattern matching for networks (e.g., "eip155:*")
func findByNetworkAndScheme[T any](networkMap map[Network]map[string]T, scheme string, network Network) T {
	var zero T

	// Try exact match first
	if schemeMap, exists := networkMap[network]; exists {
		if impl, exists := schemeMap[scheme]; exists {
			return impl
		}
	}

	// Try pattern matching
	for registeredNetwork, schemeMap := range networkMap {
		if network.Match(registeredNetwork) || registeredNetwork.Match(network) {
			if impl, exists := schemeMap[scheme]; exists {
				return impl
			}
		}
	}

	return zero
}

// findSchemesByNetwork finds all schemes for a given network
func findSchemesByNetwork[T any](networkMap map[Network]map[string]T, network Network) map[string]T {
	// Try exact match first
	if schemeMap, exists := networkMap[network]; exists {
		return schemeMap
	}

	// Try pattern matching
	for registeredNetwork, schemeMap := range networkMap {
		if network.Match(registeredNetwork) || registeredNetwork.Match(network) {
			return schemeMap
		}
	}

	return nil
}
