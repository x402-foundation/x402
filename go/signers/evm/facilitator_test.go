package evm

import (
	"context"
	"math/big"
	"testing"

	x402evm "github.com/coinbase/x402/go/mechanisms/evm"
)

func TestNewFacilitatorSignerFromPrivateKey_InvalidKey(t *testing.T) {
	tests := []struct {
		name string
		key  string
	}{
		{"empty key", ""},
		{"not hex", "invalid"},
		{"too short", "0x1234"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			_, err := NewFacilitatorSignerFromPrivateKey(tt.key, "http://localhost:8545")
			if err == nil {
				t.Error("expected error for invalid key")
			}
		})
	}
}

func TestNewFacilitatorSignerFromPrivateKey_AddressDerivation(t *testing.T) {
	// Hardhat test account #0
	signer, err := NewFacilitatorSignerFromPrivateKey(
		"0x"+testPrivateKeyHex,
		"http://localhost:8545",
	)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer signer.Close()

	expected := "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if !equalAddresses(signer.Address(), expected) {
		t.Errorf("Address() = %s, want %s", signer.Address(), expected)
	}
}

func TestNewFacilitatorSignerFromPrivateKey_WithAndWithout0xPrefix(t *testing.T) {
	s1, err := NewFacilitatorSignerFromPrivateKey("0x"+testPrivateKeyHex, "http://localhost:8545")
	if err != nil {
		t.Fatalf("with 0x prefix: %v", err)
	}
	defer s1.Close()

	s2, err := NewFacilitatorSignerFromPrivateKey(testPrivateKeyHex, "http://localhost:8545")
	if err != nil {
		t.Fatalf("without 0x prefix: %v", err)
	}
	defer s2.Close()

	if !equalAddresses(s1.Address(), s2.Address()) {
		t.Errorf("addresses should match: %s vs %s", s1.Address(), s2.Address())
	}
}

func TestFacilitatorSigner_GetAddresses(t *testing.T) {
	signer, err := NewFacilitatorSignerFromPrivateKey(testPrivateKeyHex, "http://localhost:8545")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer signer.Close()

	addrs := signer.GetAddresses()
	if len(addrs) != 1 {
		t.Fatalf("expected 1 address, got %d", len(addrs))
	}

	expected := "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"
	if !equalAddresses(addrs[0], expected) {
		t.Errorf("GetAddresses()[0] = %s, want %s", addrs[0], expected)
	}
}

func TestFacilitatorSigner_Close_ZeroesKey(t *testing.T) {
	signer, err := NewFacilitatorSignerFromPrivateKey(testPrivateKeyHex, "http://localhost:8545")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}

	// Verify key is non-zero before close
	allZero := true
	for _, b := range signer.privateKey {
		if b != 0 {
			allZero = false
			break
		}
	}
	if allZero {
		t.Fatal("private key should not be all zeros before Close()")
	}

	signer.Close()

	// Verify key is zeroed after close
	for i, b := range signer.privateKey {
		if b != 0 {
			t.Fatalf("private key byte %d not zeroed after Close(): %d", i, b)
		}
	}
}

func TestFacilitatorSigner_VerifyTypedData(t *testing.T) {
	signer, err := NewFacilitatorSignerFromPrivateKey(testPrivateKeyHex, "http://localhost:8545")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer signer.Close()

	// Create a client signer to produce a signature
	clientSigner, err := NewClientSignerFromPrivateKey(testPrivateKeyHex)
	if err != nil {
		t.Fatalf("client signer error: %v", err)
	}

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
		"nonce":       [32]byte{1, 2, 3},
	}

	// Sign with client signer
	sig, err := clientSigner.SignTypedData(context.Background(), domain, types, "TransferWithAuthorization", message)
	if err != nil {
		t.Fatalf("sign error: %v", err)
	}

	// Verify with facilitator signer — should return true for correct address
	valid, err := signer.VerifyTypedData(
		context.Background(),
		clientSigner.Address(),
		domain, types, "TransferWithAuthorization", message, sig,
	)
	if err != nil {
		t.Fatalf("verify error: %v", err)
	}
	if !valid {
		t.Error("VerifyTypedData() should return true for valid signature")
	}

	// Verify with wrong address — should return false
	valid, err = signer.VerifyTypedData(
		context.Background(),
		"0x70997970C51812dc3A010C7d01b50e0d17dc79C8", // different address
		domain, types, "TransferWithAuthorization", message, sig,
	)
	if err != nil {
		t.Fatalf("verify error: %v", err)
	}
	if valid {
		t.Error("VerifyTypedData() should return false for wrong address")
	}
}

func TestFacilitatorSigner_ImplementsInterface(t *testing.T) {
	signer, err := NewFacilitatorSignerFromPrivateKey(testPrivateKeyHex, "http://localhost:8545")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	defer signer.Close()

	// Compile-time check that FacilitatorSigner implements FacilitatorEvmSigner
	var _ x402evm.FacilitatorEvmSigner = signer
}
