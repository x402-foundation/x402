package x402

import (
	"testing"
)

func TestValidatePaymentPayload(t *testing.T) {
	tests := []struct {
		name    string
		payload PaymentPayload
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid v2 payload",
			payload: PaymentPayload{
				X402Version: 2,
				Accepted: PaymentRequirements{
					Scheme:  "exact",
					Network: "eip155:1",
				},
				Payload: map[string]interface{}{"sig": "test"},
			},
			wantErr: false,
		},
		{
			name: "valid v1 payload",
			payload: PaymentPayload{
				X402Version: 1,
				Accepted: PaymentRequirements{
					Scheme:  "exact",
					Network: "eip155:1",
				},
				Payload: map[string]interface{}{"sig": "test"},
			},
			wantErr: false,
		},
		{
			name: "invalid version",
			payload: PaymentPayload{
				X402Version: 3,
				Accepted: PaymentRequirements{
					Scheme:  "exact",
					Network: "eip155:1",
				},
				Payload: map[string]interface{}{"sig": "test"},
			},
			wantErr: true,
			errMsg:  "unsupported x402 version",
		},
		{
			name: "missing scheme",
			payload: PaymentPayload{
				X402Version: 2,
				Accepted: PaymentRequirements{
					Network: "eip155:1",
				},
				Payload: map[string]interface{}{"sig": "test"},
			},
			wantErr: true,
			errMsg:  "payment scheme is required",
		},
		{
			name: "missing network",
			payload: PaymentPayload{
				X402Version: 2,
				Accepted: PaymentRequirements{
					Scheme: "exact",
				},
				Payload: map[string]interface{}{"sig": "test"},
			},
			wantErr: true,
			errMsg:  "payment network is required",
		},
		{
			name: "missing payload",
			payload: PaymentPayload{
				X402Version: 2,
				Accepted: PaymentRequirements{
					Scheme:  "exact",
					Network: "eip155:1",
				},
			},
			wantErr: true,
			errMsg:  "payment payload is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePaymentPayload(tt.payload)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidatePaymentPayload() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil && tt.errMsg != "" {
				if err.Error() != tt.errMsg && !contains(err.Error(), tt.errMsg) {
					t.Errorf("ValidatePaymentPayload() error message = %v, want %v", err.Error(), tt.errMsg)
				}
			}
		})
	}
}

func TestValidatePaymentRequirements(t *testing.T) {
	tests := []struct {
		name    string
		req     PaymentRequirements
		wantErr bool
		errMsg  string
	}{
		{
			name: "valid requirements",
			req: PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:1",
				Asset:   "USDC",
				Amount:  "1000000",
				PayTo:   "0xrecipient",
			},
			wantErr: false,
		},
		{
			name: "missing scheme",
			req: PaymentRequirements{
				Network: "eip155:1",
				Asset:   "USDC",
				Amount:  "1000000",
				PayTo:   "0xrecipient",
			},
			wantErr: true,
			errMsg:  "payment scheme is required",
		},
		{
			name: "missing network",
			req: PaymentRequirements{
				Scheme: "exact",
				Asset:  "USDC",
				Amount: "1000000",
				PayTo:  "0xrecipient",
			},
			wantErr: true,
			errMsg:  "payment network is required",
		},
		{
			name: "missing asset",
			req: PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:1",
				Amount:  "1000000",
				PayTo:   "0xrecipient",
			},
			wantErr: true,
			errMsg:  "payment asset is required",
		},
		{
			name: "missing amount",
			req: PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:1",
				Asset:   "USDC",
				PayTo:   "0xrecipient",
				// Amount is optional for v1 compatibility (v1 uses maxAmountRequired)
			},
			wantErr: false, // Changed: Amount validation removed for v1 compatibility
		},
		{
			name: "missing payTo",
			req: PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:1",
				Asset:   "USDC",
				Amount:  "1000000",
			},
			wantErr: true,
			errMsg:  "payment recipient is required",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidatePaymentRequirements(tt.req)
			if (err != nil) != tt.wantErr {
				t.Errorf("ValidatePaymentRequirements() error = %v, wantErr %v", err, tt.wantErr)
			}
			if err != nil && tt.errMsg != "" {
				if err.Error() != tt.errMsg && !contains(err.Error(), tt.errMsg) {
					t.Errorf("ValidatePaymentRequirements() error message = %v, want %v", err.Error(), tt.errMsg)
				}
			}
		})
	}
}

func TestFindByNetworkAndScheme(t *testing.T) {
	// Create test map
	networkMap := map[Network]map[string]string{
		"eip155:1": {
			"exact":    "mainnet-exact",
			"transfer": "mainnet-transfer",
		},
		"eip155:8453": {
			"exact": "base-exact",
		},
		"eip155:*": {
			"wildcard": "any-eip155",
		},
	}

	tests := []struct {
		name     string
		scheme   string
		network  Network
		expected string
	}{
		{
			name:     "exact match mainnet exact",
			scheme:   "exact",
			network:  "eip155:1",
			expected: "mainnet-exact",
		},
		{
			name:     "exact match mainnet transfer",
			scheme:   "transfer",
			network:  "eip155:1",
			expected: "mainnet-transfer",
		},
		{
			name:     "exact match base exact",
			scheme:   "exact",
			network:  "eip155:8453",
			expected: "base-exact",
		},
		{
			name:     "wildcard match for unregistered network",
			scheme:   "wildcard",
			network:  "eip155:137", // Polygon, not explicitly registered
			expected: "any-eip155",
		},
		{
			name:     "no match",
			scheme:   "nonexistent",
			network:  "eip155:1",
			expected: "",
		},
		{
			name:     "no match for different namespace",
			scheme:   "exact",
			network:  "solana:mainnet",
			expected: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := findByNetworkAndScheme(networkMap, tt.scheme, tt.network)
			if result != tt.expected {
				t.Errorf("findByNetworkAndScheme() = %v, want %v", result, tt.expected)
			}
		})
	}
}

func TestFindSchemesByNetwork(t *testing.T) {
	// Create test map
	networkMap := map[Network]map[string]string{
		"eip155:1": {
			"exact":    "mainnet-exact",
			"transfer": "mainnet-transfer",
		},
		"eip155:8453": {
			"exact": "base-exact",
		},
		"eip155:*": {
			"wildcard": "any-eip155",
		},
	}

	tests := []struct {
		name     string
		network  Network
		expected map[string]string
		isNil    bool
	}{
		{
			name:    "exact match mainnet",
			network: "eip155:1",
			expected: map[string]string{
				"exact":    "mainnet-exact",
				"transfer": "mainnet-transfer",
			},
		},
		{
			name:    "exact match base",
			network: "eip155:8453",
			expected: map[string]string{
				"exact": "base-exact",
			},
		},
		{
			name:    "wildcard match",
			network: "eip155:137", // Polygon, matches wildcard
			expected: map[string]string{
				"wildcard": "any-eip155",
			},
		},
		{
			name:    "no match",
			network: "solana:mainnet",
			isNil:   true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := findSchemesByNetwork(networkMap, tt.network)
			if tt.isNil {
				if result != nil {
					t.Errorf("findSchemesByNetwork() = %v, want nil", result)
				}
			} else {
				if len(result) != len(tt.expected) {
					t.Errorf("findSchemesByNetwork() length = %d, want %d", len(result), len(tt.expected))
				}
				for k, v := range tt.expected {
					if result[k] != v {
						t.Errorf("findSchemesByNetwork()[%s] = %v, want %v", k, result[k], v)
					}
				}
			}
		})
	}
}

func TestNetworkPatternMatching(t *testing.T) {
	tests := []struct {
		name     string
		network1 Network
		network2 Network
		matches  bool
	}{
		{
			name:     "exact match",
			network1: "eip155:1",
			network2: "eip155:1",
			matches:  true,
		},
		{
			name:     "wildcard matches specific",
			network1: "eip155:*",
			network2: "eip155:8453",
			matches:  true,
		},
		{
			name:     "specific matches wildcard",
			network1: "eip155:8453",
			network2: "eip155:*",
			matches:  true,
		},
		{
			name:     "different namespaces",
			network1: "eip155:1",
			network2: "solana:mainnet",
			matches:  false,
		},
		{
			name:     "different chains same namespace",
			network1: "eip155:1",
			network2: "eip155:8453",
			matches:  false,
		},
		{
			name:     "wildcard different namespace",
			network1: "eip155:*",
			network2: "solana:mainnet",
			matches:  false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			result := tt.network1.Match(tt.network2)
			if result != tt.matches {
				t.Errorf("Network.Match() = %v, want %v", result, tt.matches)
			}
			// Test symmetry for non-wildcard cases
			if !contains(string(tt.network1), "*") && !contains(string(tt.network2), "*") {
				reverseResult := tt.network2.Match(tt.network1)
				if reverseResult != tt.matches {
					t.Errorf("Network.Match() not symmetric: forward = %v, reverse = %v", result, reverseResult)
				}
			}
		})
	}
}

// Helper function
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(substr) > 0 && len(s) > len(substr) &&
		(s[:len(substr)] == substr || s[len(s)-len(substr):] == substr ||
			(len(s) > len(substr) && findSubstring(s, substr))))
}

func findSubstring(s, substr string) bool {
	for i := 1; i < len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
