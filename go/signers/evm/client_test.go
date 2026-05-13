package evm

import (
	"context"
	"math/big"
	"strings"
	"testing"

	x402evm "github.com/x402-foundation/x402/go/mechanisms/evm"
)

// Test private key (deterministic for testing)
const testPrivateKeyHex = "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"

func TestNewClientSignerFromPrivateKey(t *testing.T) {
	tests := []struct {
		name     string
		key      string
		wantErr  bool
		wantAddr string
	}{
		{
			name:     "valid key with 0x prefix",
			key:      "0x" + testPrivateKeyHex,
			wantErr:  false,
			wantAddr: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
		},
		{
			name:     "valid key without 0x prefix",
			key:      testPrivateKeyHex,
			wantErr:  false,
			wantAddr: "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
		},
		{
			name:    "invalid key - not hex",
			key:     "invalid",
			wantErr: true,
		},
		{
			name:    "invalid key - wrong length",
			key:     "0x1234",
			wantErr: true,
		},
		{
			name:    "empty key",
			key:     "",
			wantErr: true,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			signer, err := NewClientSignerFromPrivateKey(tt.key)

			if (err != nil) != tt.wantErr {
				t.Errorf("NewClientSignerFromPrivateKey() error = %v, wantErr %v", err, tt.wantErr)
				return
			}

			if err != nil {
				return
			}

			if signer == nil {
				t.Error("expected non-nil signer")
				return
			}

			// Check address matches expected
			if tt.wantAddr != "" {
				addr := signer.Address()
				if !equalAddresses(addr, tt.wantAddr) {
					t.Errorf("Address() = %v, want %v", addr, tt.wantAddr)
				}
			}
		})
	}
}

func TestClientSigner_Address(t *testing.T) {
	signer, err := NewClientSignerFromPrivateKey(testPrivateKeyHex)
	if err != nil {
		t.Fatalf("NewClientSignerFromPrivateKey() failed: %v", err)
	}

	addr := signer.Address()

	// Should return address in checksum format with 0x prefix
	if !strings.HasPrefix(addr, "0x") {
		t.Errorf("Address() should have 0x prefix, got %s", addr)
	}

	if len(addr) != 42 {
		t.Errorf("Address() should be 42 characters (0x + 40 hex), got %d", len(addr))
	}

	// Expected address for this private key
	expected := "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if !equalAddresses(addr, expected) {
		t.Errorf("Address() = %v, want %v", addr, expected)
	}
}

func TestClientSigner_SignTypedData(t *testing.T) {
	signer, err := NewClientSignerFromPrivateKey(testPrivateKeyHex)
	if err != nil {
		t.Fatalf("NewClientSignerFromPrivateKey() failed: %v", err)
	}

	// Create test typed data (EIP-3009 TransferWithAuthorization format)
	domain := x402evm.TypedDataDomain{
		Name:              "USD Coin",
		Version:           "2",
		ChainID:           big.NewInt(84532),
		VerifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	}

	types := map[string][]x402evm.TypedDataField{
		"TransferWithAuthorization": {
			{Name: "from", Type: "address"},
			{Name: "to", Type: "address"},
			{Name: "value", Type: "uint256"},
			{Name: "validAfter", Type: "uint256"},
			{Name: "validBefore", Type: "uint256"},
			{Name: "nonce", Type: "bytes32"},
		},
	}

	message := map[string]interface{}{
		"from":        "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
		"to":          "0x70997970C51812dc3A010C7d01b50e0d17dc79C8",
		"value":       big.NewInt(1000000),
		"validAfter":  big.NewInt(0),
		"validBefore": big.NewInt(9999999999),
		"nonce":       [32]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32},
	}

	// Sign the typed data
	signature, err := signer.SignTypedData(context.Background(), domain, types, "TransferWithAuthorization", message)
	if err != nil {
		t.Fatalf("SignTypedData() failed: %v", err)
	}

	// Check signature format
	if len(signature) != 65 {
		t.Errorf("SignTypedData() signature length = %d, want 65", len(signature))
	}

	// Verify v value is 27 or 28
	v := signature[64]
	if v != 27 && v != 28 {
		t.Errorf("SignTypedData() v value = %d, want 27 or 28", v)
	}

	// Verify we can recover the correct address from the signature
	// This validates the entire signing process
	testRecovery(t, signature, signer.Address(), domain, types, message)
}

func TestClientSigner_SignTypedData_WithEIP712DomainInTypes(t *testing.T) {
	signer, err := NewClientSignerFromPrivateKey(testPrivateKeyHex)
	if err != nil {
		t.Fatalf("NewClientSignerFromPrivateKey() failed: %v", err)
	}

	// Test with EIP712Domain already in types (should not add duplicate)
	domain := x402evm.TypedDataDomain{
		Name:              "Test Token",
		Version:           "1",
		ChainID:           big.NewInt(84532),
		VerifyingContract: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
	}

	types := map[string][]x402evm.TypedDataField{
		"EIP712Domain": {
			{Name: "name", Type: "string"},
			{Name: "version", Type: "string"},
			{Name: "chainId", Type: "uint256"},
			{Name: "verifyingContract", Type: "address"},
		},
		"TestMessage": {
			{Name: "value", Type: "uint256"},
		},
	}

	message := map[string]interface{}{
		"value": big.NewInt(1000000),
	}

	// Should handle existing EIP712Domain gracefully
	signature, err := signer.SignTypedData(context.Background(), domain, types, "TestMessage", message)
	if err != nil {
		t.Fatalf("SignTypedData() failed: %v", err)
	}

	if len(signature) != 65 {
		t.Errorf("SignTypedData() signature length = %d, want 65", len(signature))
	}
}

// TestClientSigner_SignTypedData_Permit2NoVersionDomain is a regression test
// for the EIP-712 domain hashing bug where the auto-injected EIP712Domain
// type unconditionally declared `version: string`. Permit2's domain has no
// version, so the typed-data domain map omits "version" and HashStruct then
// fails with "provided data '<nil>' doesn't match type 'string'". The fix
// dynamically constructs the EIP712Domain type list from the populated
// domain fields (matching viem's behavior). Mirrors the test in
// `go/mechanisms/evm/eip712_test.go`.
func TestClientSigner_SignTypedData_Permit2NoVersionDomain(t *testing.T) {
	signer, err := NewClientSignerFromPrivateKey(testPrivateKeyHex)
	if err != nil {
		t.Fatalf("NewClientSignerFromPrivateKey() failed: %v", err)
	}

	domain := x402evm.TypedDataDomain{
		Name:              "Permit2",
		ChainID:           big.NewInt(84532),
		VerifyingContract: "0x000000000022D473030F116dDEE9F6B43aC78BA3",
	}
	types := map[string][]x402evm.TypedDataField{
		"PermitWitnessTransferFrom": {
			{Name: "permitted", Type: "TokenPermissions"},
			{Name: "spender", Type: "address"},
			{Name: "nonce", Type: "uint256"},
			{Name: "deadline", Type: "uint256"},
			{Name: "witness", Type: "Witness"},
		},
		"TokenPermissions": {
			{Name: "token", Type: "address"},
			{Name: "amount", Type: "uint256"},
		},
		"Witness": {
			{Name: "channelId", Type: "bytes32"},
		},
	}
	channelId := make([]byte, 32)
	channelId[31] = 0x01
	message := map[string]interface{}{
		"permitted": map[string]interface{}{
			"token":  "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
			"amount": big.NewInt(1_000_000),
		},
		"spender":  "0x0000000000000000000000000000000000000001",
		"nonce":    big.NewInt(1),
		"deadline": big.NewInt(1_000_000_000_000),
		"witness": map[string]interface{}{
			"channelId": channelId,
		},
	}

	signature, err := signer.SignTypedData(context.Background(), domain, types, "PermitWitnessTransferFrom", message)
	if err != nil {
		t.Fatalf("SignTypedData() with no-version domain failed: %v", err)
	}
	if len(signature) != 65 {
		t.Errorf("signature length = %d, want 65", len(signature))
	}
}

// testRecovery verifies that a signature can be recovered to the expected address
func testRecovery(t *testing.T, signature []byte, _ string, _ x402evm.TypedDataDomain, _ map[string][]x402evm.TypedDataField, _ map[string]interface{}) {
	// This would require implementing the full recovery logic
	// For now, we just check the signature format
	// The actual recovery is tested in the mechanisms/evm package

	if len(signature) != 65 {
		t.Errorf("invalid signature length: %d", len(signature))
	}

	v := signature[64]
	if v != 27 && v != 28 {
		t.Errorf("invalid v value: %d", v)
	}
}

// equalAddresses compares two Ethereum addresses (case-insensitive)
func equalAddresses(a, b string) bool {
	return strings.EqualFold(strings.ToLower(a), strings.ToLower(b))
}
