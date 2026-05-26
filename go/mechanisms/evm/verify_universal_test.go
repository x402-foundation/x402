package evm

import (
	"context"
	"errors"
	"testing"

	"github.com/ethereum/go-ethereum/accounts/abi"
	"github.com/ethereum/go-ethereum/common"
	"github.com/ethereum/go-ethereum/crypto"
)

func TestVerifyUniversalSignature_EOA(t *testing.T) {
	ctx := context.Background()

	// Generate a test EOA
	privateKey, err := crypto.GenerateKey()
	if err != nil {
		t.Fatalf("failed to generate key: %v", err)
	}

	address := crypto.PubkeyToAddress(privateKey.PublicKey)
	testHash := crypto.Keccak256([]byte("test message"))

	// Create valid EOA signature
	sig, err := crypto.Sign(testHash, privateKey)
	if err != nil {
		t.Fatalf("failed to sign: %v", err)
	}
	sig[64] += 27 // Adjust v value

	// Mock signer that returns empty code (EOA)
	mock := &mockFacilitatorSigner{
		getCodeResult: []byte{}, // Empty code = EOA
	}

	var hash32 [32]byte
	copy(hash32[:], testHash)

	t.Run("valid EOA signature", func(t *testing.T) {
		valid, sigData, err := VerifyUniversalSignature(
			ctx,
			mock,
			address.Hex(),
			hash32,
			sig,
			true,
		)

		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if !valid {
			t.Error("expected valid signature")
		}
		if sigData == nil {
			t.Fatal("expected sigData to be non-nil")
		}
		// Should have original signature as inner signature
		if !bytesEqual(sigData.InnerSignature, sig) {
			t.Error("expected inner signature to match original")
		}
	})

	t.Run("invalid EOA signature (wrong address)", func(t *testing.T) {
		wrongAddress := common.HexToAddress("0x0000000000000000000000000000000000000001")

		valid, _, err := VerifyUniversalSignature(
			ctx,
			mock,
			wrongAddress.Hex(),
			hash32,
			sig,
			true,
		)

		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if valid {
			t.Error("expected invalid signature")
		}
	})
}

func TestVerifyUniversalSignature_EIP1271(t *testing.T) {
	ctx := context.Background()
	wallet := "0x1234567890123456789012345678901234567890"
	testHash := [32]byte{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32}
	testSignature := make([]byte, 100) // Smart wallet signature > 65 bytes

	t.Run("valid EIP-1271 signature from deployed wallet", func(t *testing.T) {
		// Mock signer that returns code (deployed contract) and valid EIP-1271 response
		mock := &mockFacilitatorSigner{
			getCodeResult:      []byte{0x60, 0x80},             // Has bytecode = deployed contract
			readContractResult: []byte{0x16, 0x26, 0xba, 0x7e}, // Valid EIP-1271 magic value
		}

		valid, sigData, err := VerifyUniversalSignature(
			ctx,
			mock,
			wallet,
			testHash,
			testSignature,
			true,
		)

		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if !valid {
			t.Error("expected valid signature")
		}
		if sigData == nil {
			t.Error("expected sigData to be non-nil")
		}
	})

	t.Run("invalid EIP-1271 signature from deployed wallet", func(t *testing.T) {
		// Mock signer that returns code but invalid magic value
		mock := &mockFacilitatorSigner{
			getCodeResult:      []byte{0x60, 0x80},
			readContractResult: []byte{0x00, 0x00, 0x00, 0x00}, // Invalid magic value
		}

		valid, _, err := VerifyUniversalSignature(
			ctx,
			mock,
			wallet,
			testHash,
			testSignature,
			true,
		)

		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if valid {
			t.Error("expected invalid signature")
		}
	})
}

func TestVerifyUniversalSignature_ERC6492(t *testing.T) {
	ctx := context.Background()
	wallet := "0x1234567890123456789012345678901234567890"
	testHash := [32]byte{1, 2, 3, 4, 5}

	factory := common.HexToAddress("0xfactory0000000000000000000000000000000000")
	factoryCalldata := []byte("deploy calldata")
	innerSig := make([]byte, 65)

	// Create valid ERC-6492 signature
	erc6492Sig := createERC6492SignatureForTest(t, factory, factoryCalldata, innerSig)

	t.Run("undeployed wallet with ERC-6492 and allowUndeployed=true", func(t *testing.T) {
		// Mock signer that returns no code (undeployed)
		mock := &mockFacilitatorSigner{
			getCodeResult: []byte{}, // No code = undeployed
		}

		valid, sigData, err := VerifyUniversalSignature(
			ctx,
			mock,
			wallet,
			testHash,
			erc6492Sig,
			true, // allowUndeployed
		)

		if err != nil {
			t.Errorf("unexpected error: %v", err)
		}
		if valid {
			t.Error("expected ERC-6492 signature to require later simulation")
		}
		if sigData == nil {
			t.Fatal("expected sigData to be non-nil")
		}
		// Should have deployment info
		if common.BytesToAddress(sigData.Factory[:]) != factory {
			t.Errorf("factory mismatch")
		}
	})

	t.Run("undeployed wallet with ERC-6492 and allowUndeployed=false", func(t *testing.T) {
		mock := &mockFacilitatorSigner{
			getCodeResult: []byte{}, // No code = undeployed
		}

		valid, _, err := VerifyUniversalSignature(
			ctx,
			mock,
			wallet,
			testHash,
			erc6492Sig,
			false, // allowUndeployed = false
		)

		if err == nil {
			t.Error("expected error for undeployed wallet when not allowed")
		}
		if valid {
			t.Error("expected invalid result")
		}
	})

	t.Run("undeployed wallet without deployment info", func(t *testing.T) {
		// Non-ERC-6492 smart wallet signature (> 65 bytes but no ERC-6492 wrapper)
		nonERC6492Sig := make([]byte, 100)

		mock := &mockFacilitatorSigner{
			getCodeResult: []byte{}, // No code = undeployed
		}

		valid, _, err := VerifyUniversalSignature(
			ctx,
			mock,
			wallet,
			testHash,
			nonERC6492Sig,
			true, // allowUndeployed
		)

		if err == nil {
			t.Error("expected error for invalid EOA signature length when used as fallback")
		}
		if valid {
			t.Error("expected invalid result")
		}
	})
}

func TestVerifyUniversalSignature_EdgeCases(t *testing.T) {
	ctx := context.Background()
	testHash := [32]byte{1, 2, 3}

	t.Run("getCode fails", func(t *testing.T) {
		mock := &mockFacilitatorSigner{
			getCodeError: errors.New("network error"),
		}

		valid, _, err := VerifyUniversalSignature(
			ctx,
			mock,
			"0x1234",
			testHash,
			make([]byte, 100),
			true,
		)

		if err == nil {
			t.Error("expected error when GetCode fails")
		}
		if valid {
			t.Error("expected invalid result")
		}
	})

	t.Run("invalid ERC-6492 format", func(t *testing.T) {
		// Create malformed ERC-6492 signature
		invalidSig := append([]byte{0x00, 0x01}, erc6492MagicBytes...)

		mock := &mockFacilitatorSigner{
			getCodeResult: []byte{},
		}

		_, _, err := VerifyUniversalSignature(
			ctx,
			mock,
			"0x1234",
			testHash,
			invalidSig,
			true,
		)

		if err == nil {
			t.Error("expected error for malformed ERC-6492 signature")
		}
	})
}

// Helper to create ERC-6492 signatures for testing
func createERC6492SignatureForTest(t *testing.T, factory common.Address, factoryData []byte, originalSig []byte) []byte {
	addressTy, err := abi.NewType("address", "", nil)
	if err != nil {
		t.Fatalf("failed to create address type: %v", err)
	}
	bytesTy, err := abi.NewType("bytes", "", nil)
	if err != nil {
		t.Fatalf("failed to create bytes type: %v", err)
	}

	arguments := abi.Arguments{
		{Type: addressTy},
		{Type: bytesTy},
		{Type: bytesTy},
	}

	packed, err := arguments.Pack(factory, factoryData, originalSig)
	if err != nil {
		t.Fatalf("failed to pack: %v", err)
	}

	return append(packed, erc6492MagicBytes...)
}
