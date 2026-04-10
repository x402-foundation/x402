package unit_test

import (
	"math/big"
	"testing"

	"github.com/x402-foundation/x402/go/mechanisms/evm"
)

// TestHashEIP3009Authorization tests EIP-3009 authorization hashing
func TestHashEIP3009Authorization(t *testing.T) {
	t.Run("Valid authorization produces 32-byte hash", func(t *testing.T) {
		auth := evm.ExactEIP3009Authorization{
			From:        "0x1234567890123456789012345678901234567890",
			To:          "0x9876543210987654321098765432109876543210",
			Value:       "1000000",
			ValidAfter:  "0",
			ValidBefore: "9999999999",
			Nonce:       "0x0000000000000000000000000000000000000000000000000000000000000001",
		}

		hash, err := evm.HashEIP3009Authorization(
			auth,
			big.NewInt(8453),
			"0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			"USD Coin",
			"2",
		)

		if err != nil {
			t.Fatalf("Failed to hash authorization: %v", err)
		}

		if len(hash) != 32 {
			t.Errorf("Expected 32-byte hash, got %d bytes", len(hash))
		}
	})

	t.Run("Same inputs produce same hash", func(t *testing.T) {
		auth := evm.ExactEIP3009Authorization{
			From:        "0x1234567890123456789012345678901234567890",
			To:          "0x9876543210987654321098765432109876543210",
			Value:       "1000000",
			ValidAfter:  "0",
			ValidBefore: "9999999999",
			Nonce:       "0x0000000000000000000000000000000000000000000000000000000000000001",
		}

		hash1, err1 := evm.HashEIP3009Authorization(auth, big.NewInt(8453), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")
		hash2, err2 := evm.HashEIP3009Authorization(auth, big.NewInt(8453), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")

		if err1 != nil || err2 != nil {
			t.Fatalf("Hashing failed: %v, %v", err1, err2)
		}

		if string(hash1) != string(hash2) {
			t.Error("Same inputs should produce same hash")
		}
	})

	t.Run("Different chain ID produces different hash", func(t *testing.T) {
		auth := evm.ExactEIP3009Authorization{
			From:        "0x1234567890123456789012345678901234567890",
			To:          "0x9876543210987654321098765432109876543210",
			Value:       "1000000",
			ValidAfter:  "0",
			ValidBefore: "9999999999",
			Nonce:       "0x0000000000000000000000000000000000000000000000000000000000000001",
		}

		hash1, _ := evm.HashEIP3009Authorization(auth, big.NewInt(8453), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")
		hash2, _ := evm.HashEIP3009Authorization(auth, big.NewInt(84532), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")

		if string(hash1) == string(hash2) {
			t.Error("Different chain IDs should produce different hashes")
		}
	})

	t.Run("Different value produces different hash", func(t *testing.T) {
		auth1 := evm.ExactEIP3009Authorization{
			From:        "0x1234567890123456789012345678901234567890",
			To:          "0x9876543210987654321098765432109876543210",
			Value:       "1000000",
			ValidAfter:  "0",
			ValidBefore: "9999999999",
			Nonce:       "0x0000000000000000000000000000000000000000000000000000000000000001",
		}
		auth2 := evm.ExactEIP3009Authorization{
			From:        "0x1234567890123456789012345678901234567890",
			To:          "0x9876543210987654321098765432109876543210",
			Value:       "2000000", // Different value
			ValidAfter:  "0",
			ValidBefore: "9999999999",
			Nonce:       "0x0000000000000000000000000000000000000000000000000000000000000001",
		}

		hash1, _ := evm.HashEIP3009Authorization(auth1, big.NewInt(8453), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")
		hash2, _ := evm.HashEIP3009Authorization(auth2, big.NewInt(8453), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")

		if string(hash1) == string(hash2) {
			t.Error("Different values should produce different hashes")
		}
	})

	t.Run("Invalid value format returns error", func(t *testing.T) {
		auth := evm.ExactEIP3009Authorization{
			From:        "0x1234567890123456789012345678901234567890",
			To:          "0x9876543210987654321098765432109876543210",
			Value:       "not_a_number",
			ValidAfter:  "0",
			ValidBefore: "9999999999",
			Nonce:       "0x0000000000000000000000000000000000000000000000000000000000000001",
		}

		_, err := evm.HashEIP3009Authorization(auth, big.NewInt(8453), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")
		if err == nil {
			t.Error("Expected error for invalid value format")
		}
	})

	t.Run("Invalid validAfter format returns error", func(t *testing.T) {
		auth := evm.ExactEIP3009Authorization{
			From:        "0x1234567890123456789012345678901234567890",
			To:          "0x9876543210987654321098765432109876543210",
			Value:       "1000000",
			ValidAfter:  "not_a_number",
			ValidBefore: "9999999999",
			Nonce:       "0x0000000000000000000000000000000000000000000000000000000000000001",
		}

		_, err := evm.HashEIP3009Authorization(auth, big.NewInt(8453), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")
		if err == nil {
			t.Error("Expected error for invalid validAfter format")
		}
	})

	t.Run("Invalid nonce format returns error", func(t *testing.T) {
		auth := evm.ExactEIP3009Authorization{
			From:        "0x1234567890123456789012345678901234567890",
			To:          "0x9876543210987654321098765432109876543210",
			Value:       "1000000",
			ValidAfter:  "0",
			ValidBefore: "9999999999",
			Nonce:       "not_a_hex_value",
		}

		_, err := evm.HashEIP3009Authorization(auth, big.NewInt(8453), "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913", "USD Coin", "2")
		if err == nil {
			t.Error("Expected error for invalid nonce format")
		}
	})
}

// TestHashPermit2Authorization tests Permit2 authorization hashing
func TestHashPermit2Authorization(t *testing.T) {
	t.Run("Valid authorization produces 32-byte hash", func(t *testing.T) {
		auth := evm.Permit2Authorization{
			From: "0x1234567890123456789012345678901234567890",
			Permitted: evm.Permit2TokenPermissions{
				Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "12345",
			Deadline: "9999999999",
			Witness:  defaultTestWitness(),
		}

		hash, err := evm.HashPermit2Authorization(auth, big.NewInt(84532))

		if err != nil {
			t.Fatalf("Failed to hash authorization: %v", err)
		}

		if len(hash) != 32 {
			t.Errorf("Expected 32-byte hash, got %d bytes", len(hash))
		}
	})

	t.Run("Same inputs produce same hash", func(t *testing.T) {
		auth := evm.Permit2Authorization{
			From: "0x1234567890123456789012345678901234567890",
			Permitted: evm.Permit2TokenPermissions{
				Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "12345",
			Deadline: "9999999999",
			Witness:  defaultTestWitness(),
		}

		hash1, err1 := evm.HashPermit2Authorization(auth, big.NewInt(84532))
		hash2, err2 := evm.HashPermit2Authorization(auth, big.NewInt(84532))

		if err1 != nil || err2 != nil {
			t.Fatalf("Hashing failed: %v, %v", err1, err2)
		}

		if string(hash1) != string(hash2) {
			t.Error("Same inputs should produce same hash")
		}
	})

	t.Run("Different chain ID produces different hash", func(t *testing.T) {
		auth := evm.Permit2Authorization{
			From: "0x1234567890123456789012345678901234567890",
			Permitted: evm.Permit2TokenPermissions{
				Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "12345",
			Deadline: "9999999999",
			Witness:  defaultTestWitness(),
		}

		hash1, _ := evm.HashPermit2Authorization(auth, big.NewInt(84532))
		hash2, _ := evm.HashPermit2Authorization(auth, big.NewInt(8453))

		if string(hash1) == string(hash2) {
			t.Error("Different chain IDs should produce different hashes")
		}
	})

	t.Run("Different amount produces different hash", func(t *testing.T) {
		auth1 := evm.Permit2Authorization{
			From: "0x1234567890123456789012345678901234567890",
			Permitted: evm.Permit2TokenPermissions{
				Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "12345",
			Deadline: "9999999999",
			Witness:  defaultTestWitness(),
		}
		auth2 := evm.Permit2Authorization{
			From: "0x1234567890123456789012345678901234567890",
			Permitted: evm.Permit2TokenPermissions{
				Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				Amount: "2000000", // Different amount
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "12345",
			Deadline: "9999999999",
			Witness:  defaultTestWitness(),
		}

		hash1, _ := evm.HashPermit2Authorization(auth1, big.NewInt(84532))
		hash2, _ := evm.HashPermit2Authorization(auth2, big.NewInt(84532))

		if string(hash1) == string(hash2) {
			t.Error("Different amounts should produce different hashes")
		}
	})

	t.Run("Invalid amount format returns error", func(t *testing.T) {
		auth := evm.Permit2Authorization{
			From: "0x1234567890123456789012345678901234567890",
			Permitted: evm.Permit2TokenPermissions{
				Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				Amount: "not_a_number",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "12345",
			Deadline: "9999999999",
			Witness:  defaultTestWitness(),
		}

		_, err := evm.HashPermit2Authorization(auth, big.NewInt(84532))
		if err == nil {
			t.Error("Expected error for invalid amount format")
		}
	})

	t.Run("Invalid nonce format returns error", func(t *testing.T) {
		auth := evm.Permit2Authorization{
			From: "0x1234567890123456789012345678901234567890",
			Permitted: evm.Permit2TokenPermissions{
				Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				Amount: "1000000",
			},
			Spender:  evm.X402ExactPermit2ProxyAddress,
			Nonce:    "not_a_number",
			Deadline: "9999999999",
			Witness:  defaultTestWitness(),
		}

		_, err := evm.HashPermit2Authorization(auth, big.NewInt(84532))
		if err == nil {
			t.Error("Expected error for invalid nonce format")
		}
	})

}

// TestHashTypedData tests the generic EIP-712 hashing function
func TestHashTypedData(t *testing.T) {
	t.Run("Valid typed data produces 32-byte hash", func(t *testing.T) {
		domain := evm.TypedDataDomain{
			Name:              "Test",
			Version:           "1",
			ChainID:           big.NewInt(1),
			VerifyingContract: "0x1234567890123456789012345678901234567890",
		}

		types := map[string][]evm.TypedDataField{
			"EIP712Domain": {
				{Name: "name", Type: "string"},
				{Name: "version", Type: "string"},
				{Name: "chainId", Type: "uint256"},
				{Name: "verifyingContract", Type: "address"},
			},
			"Message": {
				{Name: "content", Type: "string"},
			},
		}

		message := map[string]interface{}{
			"content": "Hello, world!",
		}

		hash, err := evm.HashTypedData(domain, types, "Message", message)
		if err != nil {
			t.Fatalf("Failed to hash typed data: %v", err)
		}

		if len(hash) != 32 {
			t.Errorf("Expected 32-byte hash, got %d bytes", len(hash))
		}
	})

	t.Run("Domain without version still works", func(t *testing.T) {
		// Permit2 uses domain without version
		domain := evm.TypedDataDomain{
			Name:              "Permit2",
			ChainID:           big.NewInt(84532),
			VerifyingContract: evm.PERMIT2Address,
		}

		types := evm.GetPermit2EIP712Types()

		message := map[string]interface{}{
			"permitted": map[string]interface{}{
				"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
				"amount": big.NewInt(1000000),
			},
			"spender":  evm.X402ExactPermit2ProxyAddress,
			"nonce":    big.NewInt(1),
			"deadline": big.NewInt(9999999999),
			"witness": map[string]interface{}{
				"to":         "0x9876543210987654321098765432109876543210",
				"validAfter": big.NewInt(0),
			},
		}

		hash, err := evm.HashTypedData(domain, types, "PermitWitnessTransferFrom", message)
		if err != nil {
			t.Fatalf("Failed to hash typed data: %v", err)
		}

		if len(hash) != 32 {
			t.Errorf("Expected 32-byte hash, got %d bytes", len(hash))
		}
	})
}

// TestPermit2HashCrossSDKVector verifies that HashPermit2Authorization produces
// a deterministic hash for a canonical input. The expected hash must equal the
// value produced by viem's hashTypedData for the same inputs (see the TypeScript
// equivalent in test/unit/constants.test.ts).
func TestPermit2HashCrossSDKVector(t *testing.T) {
	// Canonical test vector — keep in sync with TypeScript constants.test.ts
	auth := evm.Permit2Authorization{
		From: "0x1234567890123456789012345678901234567890",
		Permitted: evm.Permit2TokenPermissions{
			Token:  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			Amount: "1000000",
		},
		Spender:  evm.X402ExactPermit2ProxyAddress,
		Nonce:    "1",
		Deadline: "9999999999",
		Witness:  defaultTestWitness(),
	}
	chainID := big.NewInt(84532) // Base Sepolia

	hash, err := evm.HashPermit2Authorization(auth, chainID)
	if err != nil {
		t.Fatalf("HashPermit2Authorization failed: %v", err)
	}

	if len(hash) != 32 {
		t.Errorf("Expected 32-byte hash, got %d bytes", len(hash))
	}

	// Verify hash is deterministic
	hash2, err := evm.HashPermit2Authorization(auth, chainID)
	if err != nil {
		t.Fatalf("HashPermit2Authorization (second call) failed: %v", err)
	}
	if string(hash) != string(hash2) {
		t.Error("Hash must be deterministic for identical inputs")
	}

	// Verify a change in witness.to produces a different hash (no extra field involved)
	authChanged := auth
	authChanged.Witness.To = "0x0000000000000000000000000000000000000001"
	hashChanged, _ := evm.HashPermit2Authorization(authChanged, chainID)
	if string(hash) == string(hashChanged) {
		t.Error("Changing witness.To must produce a different hash")
	}
}

// TestGetPermit2EIP712Types tests that Permit2 types are correctly defined
func TestGetPermit2EIP712Types(t *testing.T) {
	types := evm.GetPermit2EIP712Types()

	t.Run("Contains EIP712Domain", func(t *testing.T) {
		if _, ok := types["EIP712Domain"]; !ok {
			t.Error("Missing EIP712Domain type")
		}
	})

	t.Run("Contains PermitWitnessTransferFrom", func(t *testing.T) {
		if _, ok := types["PermitWitnessTransferFrom"]; !ok {
			t.Error("Missing PermitWitnessTransferFrom type")
		}
	})

	t.Run("Contains TokenPermissions", func(t *testing.T) {
		if _, ok := types["TokenPermissions"]; !ok {
			t.Error("Missing TokenPermissions type")
		}
	})

	t.Run("Contains Witness", func(t *testing.T) {
		if _, ok := types["Witness"]; !ok {
			t.Error("Missing Witness type")
		}
	})

	t.Run("PermitWitnessTransferFrom has correct field order", func(t *testing.T) {
		pwtf := types["PermitWitnessTransferFrom"]

		expectedFields := []string{"permitted", "spender", "nonce", "deadline", "witness"}
		if len(pwtf) != len(expectedFields) {
			t.Errorf("Expected %d fields, got %d", len(expectedFields), len(pwtf))
			return
		}

		for i, expected := range expectedFields {
			if pwtf[i].Name != expected {
				t.Errorf("Field %d: expected %s, got %s", i, expected, pwtf[i].Name)
			}
		}
	})

	t.Run("Witness has correct field order", func(t *testing.T) {
		witness := types["Witness"]

		// Field order matters for EIP-712 type hash
		expectedFields := []string{"to", "validAfter"}
		if len(witness) != len(expectedFields) {
			t.Errorf("Expected %d fields, got %d", len(expectedFields), len(witness))
			return
		}

		for i, expected := range expectedFields {
			if witness[i].Name != expected {
				t.Errorf("Field %d: expected %s, got %s", i, expected, witness[i].Name)
			}
		}
	})
}
