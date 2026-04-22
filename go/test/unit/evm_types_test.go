package unit_test

import (
	"testing"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// TestEIP3009PayloadParsing tests EIP-3009 payload parsing and serialization
func TestEIP3009PayloadParsing(t *testing.T) {
	t.Run("PayloadFromMap parses correctly", func(t *testing.T) {
		payloadMap := map[string]interface{}{
			"signature": "0xabcdef1234567890",
			"authorization": map[string]interface{}{
				"from":        "0x1234567890123456789012345678901234567890",
				"to":          "0x9876543210987654321098765432109876543210",
				"value":       "1000000",
				"validAfter":  "0",
				"validBefore": "9999999999",
				"nonce":       "0x0000000000000000000000000000000000000000000000000000000000000001",
			},
		}

		payload, err := evm.PayloadFromMap(payloadMap)
		if err != nil {
			t.Fatalf("Failed to parse payload: %v", err)
		}

		if payload.Signature != "0xabcdef1234567890" {
			t.Errorf("Signature mismatch: %s", payload.Signature)
		}

		if payload.Authorization.From != "0x1234567890123456789012345678901234567890" {
			t.Errorf("From mismatch: %s", payload.Authorization.From)
		}

		if payload.Authorization.To != "0x9876543210987654321098765432109876543210" {
			t.Errorf("To mismatch: %s", payload.Authorization.To)
		}

		if payload.Authorization.Value != "1000000" {
			t.Errorf("Value mismatch: %s", payload.Authorization.Value)
		}
	})

	t.Run("PayloadFromMap handles missing signature", func(t *testing.T) {
		payloadMap := map[string]interface{}{
			"authorization": map[string]interface{}{
				"from":        "0x1234567890123456789012345678901234567890",
				"to":          "0x9876543210987654321098765432109876543210",
				"value":       "1000000",
				"validAfter":  "0",
				"validBefore": "9999999999",
				"nonce":       "0x0000000000000000000000000000000000000000000000000000000000000001",
			},
		}

		payload, err := evm.PayloadFromMap(payloadMap)
		if err != nil {
			t.Fatalf("Failed to parse payload: %v", err)
		}

		// Signature should be empty
		if payload.Signature != "" {
			t.Errorf("Expected empty signature, got: %s", payload.Signature)
		}
	})

	t.Run("ToMap round-trips correctly", func(t *testing.T) {
		original := &evm.ExactEIP3009Payload{
			Signature: "0xsignature",
			Authorization: evm.ExactEIP3009Authorization{
				From:        "0x1111111111111111111111111111111111111111",
				To:          "0x2222222222222222222222222222222222222222",
				Value:       "500000",
				ValidAfter:  "100",
				ValidBefore: "999999",
				Nonce:       "0x0000000000000000000000000000000000000000000000000000000000000099",
			},
		}

		payloadMap := original.ToMap()
		parsed, err := evm.PayloadFromMap(payloadMap)
		if err != nil {
			t.Fatalf("Failed to parse: %v", err)
		}

		if parsed.Signature != original.Signature {
			t.Errorf("Signature mismatch")
		}

		if parsed.Authorization.From != original.Authorization.From {
			t.Errorf("From mismatch")
		}

		if parsed.Authorization.To != original.Authorization.To {
			t.Errorf("To mismatch")
		}

		if parsed.Authorization.Value != original.Authorization.Value {
			t.Errorf("Value mismatch")
		}

		if parsed.Authorization.ValidAfter != original.Authorization.ValidAfter {
			t.Errorf("ValidAfter mismatch")
		}

		if parsed.Authorization.ValidBefore != original.Authorization.ValidBefore {
			t.Errorf("ValidBefore mismatch")
		}

		if parsed.Authorization.Nonce != original.Authorization.Nonce {
			t.Errorf("Nonce mismatch")
		}
	})
}

// TestPermit2PayloadParsing tests Permit2 payload parsing and serialization
func TestPermit2PayloadParsing(t *testing.T) {
	t.Run("Permit2PayloadFromMap parses correctly", func(t *testing.T) {
		payloadMap := map[string]interface{}{
			"signature": "0xabcdef",
			"permit2Authorization": map[string]interface{}{
				"from":     "0x1234567890123456789012345678901234567890",
				"spender":  evm.X402ExactPermit2ProxyAddress,
				"nonce":    "12345",
				"deadline": "9999999999",
				"permitted": map[string]interface{}{
					"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
					"amount": "1000000",
				},
				"witness": map[string]interface{}{
					"to":         "0x9876543210987654321098765432109876543210",
					"validAfter": "0",
				},
			},
		}

		payload, err := evm.Permit2PayloadFromMap(payloadMap)
		if err != nil {
			t.Fatalf("Failed to parse payload: %v", err)
		}

		if payload.Signature != "0xabcdef" {
			t.Errorf("Signature mismatch: %s", payload.Signature)
		}

		if payload.Permit2Authorization.From != "0x1234567890123456789012345678901234567890" {
			t.Errorf("From mismatch: %s", payload.Permit2Authorization.From)
		}

		if payload.Permit2Authorization.Spender != evm.X402ExactPermit2ProxyAddress {
			t.Errorf("Spender mismatch: %s", payload.Permit2Authorization.Spender)
		}

		if payload.Permit2Authorization.Permitted.Amount != "1000000" {
			t.Errorf("Amount mismatch: %s", payload.Permit2Authorization.Permitted.Amount)
		}

		if payload.Permit2Authorization.Witness.To != "0x9876543210987654321098765432109876543210" {
			t.Errorf("Witness.To mismatch: %s", payload.Permit2Authorization.Witness.To)
		}
	})

	t.Run("Permit2PayloadFromMap rejects missing permit2Authorization", func(t *testing.T) {
		payloadMap := map[string]interface{}{
			"signature": "0xabcdef",
			// permit2Authorization is missing
		}

		_, err := evm.Permit2PayloadFromMap(payloadMap)
		if err == nil {
			t.Error("Expected error for missing permit2Authorization")
		}
	})

	t.Run("Permit2PayloadFromMap rejects missing required fields", func(t *testing.T) {
		testCases := []struct {
			name       string
			payloadMap map[string]interface{}
		}{
			{
				name: "missing from",
				payloadMap: map[string]interface{}{
					"signature": "0xabcdef",
					"permit2Authorization": map[string]interface{}{
						"spender":  evm.X402ExactPermit2ProxyAddress,
						"nonce":    "12345",
						"deadline": "9999999999",
						"permitted": map[string]interface{}{
							"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
							"amount": "1000000",
						},
						"witness": map[string]interface{}{
							"to":         "0x9876543210987654321098765432109876543210",
							"validAfter": "0",
						},
					},
				},
			},
			{
				name: "missing spender",
				payloadMap: map[string]interface{}{
					"signature": "0xabcdef",
					"permit2Authorization": map[string]interface{}{
						"from":     "0x1234567890123456789012345678901234567890",
						"nonce":    "12345",
						"deadline": "9999999999",
						"permitted": map[string]interface{}{
							"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
							"amount": "1000000",
						},
						"witness": map[string]interface{}{
							"to":         "0x9876543210987654321098765432109876543210",
							"validAfter": "0",
						},
					},
				},
			},
			{
				name: "missing nonce",
				payloadMap: map[string]interface{}{
					"signature": "0xabcdef",
					"permit2Authorization": map[string]interface{}{
						"from":     "0x1234567890123456789012345678901234567890",
						"spender":  evm.X402ExactPermit2ProxyAddress,
						"deadline": "9999999999",
						"permitted": map[string]interface{}{
							"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
							"amount": "1000000",
						},
						"witness": map[string]interface{}{
							"to":         "0x9876543210987654321098765432109876543210",
							"validAfter": "0",
						},
					},
				},
			},
			{
				name: "missing deadline",
				payloadMap: map[string]interface{}{
					"signature": "0xabcdef",
					"permit2Authorization": map[string]interface{}{
						"from":    "0x1234567890123456789012345678901234567890",
						"spender": evm.X402ExactPermit2ProxyAddress,
						"nonce":   "12345",
						"permitted": map[string]interface{}{
							"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
							"amount": "1000000",
						},
						"witness": map[string]interface{}{
							"to":         "0x9876543210987654321098765432109876543210",
							"validAfter": "0",
						},
					},
				},
			},
			{
				name: "missing permitted",
				payloadMap: map[string]interface{}{
					"signature": "0xabcdef",
					"permit2Authorization": map[string]interface{}{
						"from":     "0x1234567890123456789012345678901234567890",
						"spender":  evm.X402ExactPermit2ProxyAddress,
						"nonce":    "12345",
						"deadline": "9999999999",
						"witness": map[string]interface{}{
							"to":         "0x9876543210987654321098765432109876543210",
							"validAfter": "0",
						},
					},
				},
			},
			{
				name: "missing witness",
				payloadMap: map[string]interface{}{
					"signature": "0xabcdef",
					"permit2Authorization": map[string]interface{}{
						"from":     "0x1234567890123456789012345678901234567890",
						"spender":  evm.X402ExactPermit2ProxyAddress,
						"nonce":    "12345",
						"deadline": "9999999999",
						"permitted": map[string]interface{}{
							"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
							"amount": "1000000",
						},
					},
				},
			},
			{
				name: "missing permitted.token",
				payloadMap: map[string]interface{}{
					"signature": "0xabcdef",
					"permit2Authorization": map[string]interface{}{
						"from":     "0x1234567890123456789012345678901234567890",
						"spender":  evm.X402ExactPermit2ProxyAddress,
						"nonce":    "12345",
						"deadline": "9999999999",
						"permitted": map[string]interface{}{
							"amount": "1000000",
						},
						"witness": map[string]interface{}{
							"to":         "0x9876543210987654321098765432109876543210",
							"validAfter": "0",
						},
					},
				},
			},
			{
				name: "missing witness.to",
				payloadMap: map[string]interface{}{
					"signature": "0xabcdef",
					"permit2Authorization": map[string]interface{}{
						"from":     "0x1234567890123456789012345678901234567890",
						"spender":  evm.X402ExactPermit2ProxyAddress,
						"nonce":    "12345",
						"deadline": "9999999999",
						"permitted": map[string]interface{}{
							"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
							"amount": "1000000",
						},
						"witness": map[string]interface{}{
							"validAfter": "0",
						},
					},
				},
			},
		}

		for _, tc := range testCases {
			t.Run(tc.name, func(t *testing.T) {
				_, err := evm.Permit2PayloadFromMap(tc.payloadMap)
				if err == nil {
					t.Errorf("Expected error for %s", tc.name)
				}
			})
		}
	})

	t.Run("Permit2Payload ToMap round-trips correctly", func(t *testing.T) {
		original := &evm.ExactPermit2Payload{
			Signature: "0xsignature",
			Permit2Authorization: evm.Permit2Authorization{
				From: "0x1111111111111111111111111111111111111111",
				Permitted: evm.Permit2TokenPermissions{
					Token:  "0x2222222222222222222222222222222222222222",
					Amount: "500000",
				},
				Spender:  evm.X402ExactPermit2ProxyAddress,
				Nonce:    "99999",
				Deadline: "1234567890",
				Witness: evm.Permit2Witness{
					To:         "0x3333333333333333333333333333333333333333",
					ValidAfter: "100",
				},
			},
		}

		payloadMap := original.ToMap()
		parsed, err := evm.Permit2PayloadFromMap(payloadMap)
		if err != nil {
			t.Fatalf("Failed to parse: %v", err)
		}

		if parsed.Signature != original.Signature {
			t.Errorf("Signature mismatch")
		}

		if parsed.Permit2Authorization.From != original.Permit2Authorization.From {
			t.Errorf("From mismatch")
		}

		if parsed.Permit2Authorization.Permitted.Token != original.Permit2Authorization.Permitted.Token {
			t.Errorf("Token mismatch")
		}

		if parsed.Permit2Authorization.Permitted.Amount != original.Permit2Authorization.Permitted.Amount {
			t.Errorf("Amount mismatch")
		}

		if parsed.Permit2Authorization.Spender != original.Permit2Authorization.Spender {
			t.Errorf("Spender mismatch")
		}

		if parsed.Permit2Authorization.Nonce != original.Permit2Authorization.Nonce {
			t.Errorf("Nonce mismatch")
		}

		if parsed.Permit2Authorization.Deadline != original.Permit2Authorization.Deadline {
			t.Errorf("Deadline mismatch")
		}

		if parsed.Permit2Authorization.Witness.To != original.Permit2Authorization.Witness.To {
			t.Errorf("Witness.To mismatch")
		}

		if parsed.Permit2Authorization.Witness.ValidAfter != original.Permit2Authorization.Witness.ValidAfter {
			t.Errorf("Witness.ValidAfter mismatch")
		}
	})
}

// TestPayloadTypeGuards tests payload type detection functions
func TestPayloadTypeGuards(t *testing.T) {
	t.Run("IsPermit2Payload returns true for Permit2 payloads", func(t *testing.T) {
		payload := map[string]interface{}{
			"signature": "0x1234",
			"permit2Authorization": map[string]interface{}{
				"from": "0x1234567890123456789012345678901234567890",
			},
		}
		if !evm.IsPermit2Payload(payload) {
			t.Error("Expected IsPermit2Payload to return true")
		}
	})

	t.Run("IsPermit2Payload returns false for EIP-3009 payloads", func(t *testing.T) {
		payload := map[string]interface{}{
			"signature": "0x1234",
			"authorization": map[string]interface{}{
				"from": "0x1234567890123456789012345678901234567890",
			},
		}
		if evm.IsPermit2Payload(payload) {
			t.Error("Expected IsPermit2Payload to return false")
		}
	})

	t.Run("IsPermit2Payload returns false for empty payload", func(t *testing.T) {
		payload := map[string]interface{}{}
		if evm.IsPermit2Payload(payload) {
			t.Error("Expected IsPermit2Payload to return false for empty payload")
		}
	})

	t.Run("IsEIP3009Payload returns true for EIP-3009 payloads", func(t *testing.T) {
		payload := map[string]interface{}{
			"signature": "0x1234",
			"authorization": map[string]interface{}{
				"from": "0x1234567890123456789012345678901234567890",
			},
		}
		if !evm.IsEIP3009Payload(payload) {
			t.Error("Expected IsEIP3009Payload to return true")
		}
	})

	t.Run("IsEIP3009Payload returns false for Permit2 payloads", func(t *testing.T) {
		payload := map[string]interface{}{
			"signature": "0x1234",
			"permit2Authorization": map[string]interface{}{
				"from": "0x1234567890123456789012345678901234567890",
			},
		}
		if evm.IsEIP3009Payload(payload) {
			t.Error("Expected IsEIP3009Payload to return false")
		}
	})

	t.Run("IsEIP3009Payload returns false for empty payload", func(t *testing.T) {
		payload := map[string]interface{}{}
		if evm.IsEIP3009Payload(payload) {
			t.Error("Expected IsEIP3009Payload to return false for empty payload")
		}
	})

	t.Run("Payloads are mutually exclusive", func(t *testing.T) {
		permit2Payload := map[string]interface{}{
			"permit2Authorization": map[string]interface{}{},
		}
		eip3009Payload := map[string]interface{}{
			"authorization": map[string]interface{}{},
		}

		// Permit2 payload
		if evm.IsPermit2Payload(permit2Payload) && evm.IsEIP3009Payload(permit2Payload) {
			t.Error("Payload cannot be both Permit2 and EIP-3009")
		}

		// EIP-3009 payload
		if evm.IsPermit2Payload(eip3009Payload) && evm.IsEIP3009Payload(eip3009Payload) {
			t.Error("Payload cannot be both Permit2 and EIP-3009")
		}
	})
}

// TestAssetTransferMethod tests asset transfer method constants
func TestAssetTransferMethod(t *testing.T) {
	t.Run("AssetTransferMethodEIP3009 is correct", func(t *testing.T) {
		if evm.AssetTransferMethodEIP3009 != "eip3009" {
			t.Errorf("Expected 'eip3009', got %s", evm.AssetTransferMethodEIP3009)
		}
	})

	t.Run("AssetTransferMethodPermit2 is correct", func(t *testing.T) {
		if evm.AssetTransferMethodPermit2 != "permit2" {
			t.Errorf("Expected 'permit2', got %s", evm.AssetTransferMethodPermit2)
		}
	})
}

// TestPermit2Constants tests Permit2 constant values
func TestPermit2Constants(t *testing.T) {
	t.Run("PERMIT2Address is correct canonical address", func(t *testing.T) {
		// Canonical Uniswap Permit2 address
		expected := "0x000000000022D473030F116dDEE9F6B43aC78BA3"
		if evm.PERMIT2Address != expected {
			t.Errorf("PERMIT2Address mismatch: expected %s, got %s", expected, evm.PERMIT2Address)
		}
	})

	t.Run("X402ExactPermit2ProxyAddress has vanity format", func(t *testing.T) {
		// Should start with 0x4020... and end with ...0001
		addr := evm.X402ExactPermit2ProxyAddress
		if len(addr) != 42 {
			t.Errorf("Invalid address length: %d", len(addr))
		}

		if addr[:6] != "0x4020" {
			t.Errorf("Expected vanity prefix 0x4020, got %s", addr[:6])
		}

		if addr[len(addr)-4:] != "0001" {
			t.Errorf("Expected vanity suffix 0001, got %s", addr[len(addr)-4:])
		}
	})

	t.Run("X402UptoPermit2ProxyAddress has vanity format", func(t *testing.T) {
		addr := evm.X402UptoPermit2ProxyAddress
		if len(addr) != 42 {
			t.Errorf("Invalid address length: %d", len(addr))
		}

		if addr[:6] != "0x4020" {
			t.Errorf("Expected vanity prefix 0x4020, got %s", addr[:6])
		}

		if addr[len(addr)-4:] != "0002" {
			t.Errorf("Expected vanity suffix 0002, got %s", addr[len(addr)-4:])
		}
	})

	t.Run("Permit2DeadlineBuffer is reasonable", func(t *testing.T) {
		// Should be a small number of seconds (buffer for block time)
		if evm.Permit2DeadlineBuffer <= 0 {
			t.Error("Permit2DeadlineBuffer should be positive")
		}

		if evm.Permit2DeadlineBuffer > 60 {
			t.Error("Permit2DeadlineBuffer seems too large (> 60 seconds)")
		}
	})
}

// TestSchemeExact tests the scheme constant
func TestSchemeExact(t *testing.T) {
	if evm.SchemeExact != "exact" {
		t.Errorf("Expected 'exact', got %s", evm.SchemeExact)
	}
}
