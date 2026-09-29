package evm

import (
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/crypto"
)

// mockStrictSigner implements FacilitatorEvmSigner for strict primitive tests.
type mockStrictSigner struct {
	code             []byte
	codeErr          error
	isValidSigResult [4]byte
	isValidSigErr    bool
}

func (m *mockStrictSigner) GetCode(_ context.Context, _ string) ([]byte, error) {
	return m.code, m.codeErr
}
func (m *mockStrictSigner) ReadContract(_ context.Context, _ string, _ []byte, fn string, _ ...interface{}) (interface{}, error) {
	if fn == "isValidSignature" {
		if m.isValidSigErr {
			return nil, errors.New("revert")
		}
		return m.isValidSigResult[:], nil
	}
	return nil, nil
}
func (m *mockStrictSigner) GetAddresses() []string { return nil }
func (m *mockStrictSigner) GetBalance(_ context.Context, _, _ string) (*big.Int, error) {
	return big.NewInt(0), nil
}
func (m *mockStrictSigner) GetChainID(_ context.Context) (*big.Int, error) { return big.NewInt(1), nil }
func (m *mockStrictSigner) WriteContract(_ context.Context, _ string, _ []byte, _ string, _ []byte, _ ...interface{}) (string, error) {
	return "", nil
}
func (m *mockStrictSigner) SendTransaction(_ context.Context, _ string, _ []byte) (string, error) {
	return "", nil
}
func (m *mockStrictSigner) WaitForTransactionReceipt(_ context.Context, _ string) (*TransactionReceipt, error) {
	return nil, nil
}
func (m *mockStrictSigner) VerifyTypedData(_ context.Context, _ string, _ TypedDataDomain, _ map[string][]TypedDataField, _ string, _ map[string]interface{}, _ []byte) (bool, error) {
	return false, nil
}

func TestVerifySignatureStrict_EOA_ValidSig(t *testing.T) {
	privKey, _ := crypto.GenerateKey()
	addr := crypto.PubkeyToAddress(privKey.PublicKey)
	hash := crypto.Keccak256([]byte("test message"))

	sig, _ := crypto.Sign(hash, privKey)
	sig[64] += 27

	var hash32 [32]byte
	copy(hash32[:], hash)

	mock := &mockStrictSigner{code: nil} // EOA: no code
	valid, err := VerifySignatureStrict(context.Background(), mock, addr.Hex(), hash32, sig)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Error("expected valid for EOA with correct ECDSA sig")
	}
}

func TestVerifySignatureStrict_EOA_WrongAddress(t *testing.T) {
	privKey, _ := crypto.GenerateKey()
	hash := crypto.Keccak256([]byte("test"))
	sig, _ := crypto.Sign(hash, privKey)
	sig[64] += 27

	var hash32 [32]byte
	copy(hash32[:], hash)

	mock := &mockStrictSigner{code: nil}
	valid, err := VerifySignatureStrict(context.Background(), mock, "0x0000000000000000000000000000000000000001", hash32, sig)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if valid {
		t.Error("expected invalid for wrong address")
	}
}

func TestVerifySignatureStrict_Contract_1271AcceptsReturnsTrue(t *testing.T) {
	mock := &mockStrictSigner{
		code:             []byte{0x60, 0x80},              // has code → EIP-1271 path
		isValidSigResult: [4]byte{0x16, 0x26, 0xba, 0x7e}, // magic value — delegate accepts
	}
	var hash32 [32]byte
	valid, err := VerifySignatureStrict(context.Background(), mock, "0x1234567890123456789012345678901234567890", hash32, make([]byte, 65))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !valid {
		t.Error("expected valid when 1271 returns magic")
	}
}

func TestVerifySignatureStrict_Contract_1271RejectsReturnsFalse(t *testing.T) {
	mock := &mockStrictSigner{
		code:             []byte{0x60, 0x80},
		isValidSigResult: [4]byte{0xff, 0xff, 0xff, 0xff}, // failure
	}
	var hash32 [32]byte
	valid, err := VerifySignatureStrict(context.Background(), mock, "0x1234567890123456789012345678901234567890", hash32, make([]byte, 65))
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if valid {
		t.Error("expected invalid when 1271 returns failure")
	}
}

// REGRESSION TEST: ERC-7702 delegated EOA whose delegate rejects raw ECDSA.
// Empirically verified on Base Sepolia (see /tmp/x402-exp/RESULTS.md):
// OLD code returned valid via ECDSA fallback; on-chain USDC reverted.
// The strict primitive must return invalid to match on-chain semantics.
func TestVerifySignatureStrict_ERC7702_DelegateRejects_ReturnsInvalid(t *testing.T) {
	privKey, _ := crypto.GenerateKey()
	eoa := crypto.PubkeyToAddress(privKey.PublicKey)
	hash := crypto.Keccak256([]byte("test"))
	sig, _ := crypto.Sign(hash, privKey)
	sig[64] += 27

	var hash32 [32]byte
	copy(hash32[:], hash)

	// 7702-delegated address: has bytecode (delegation designation). The delegate
	// always rejects — its isValidSignature returns the failure value.
	mock := &mockStrictSigner{
		code:             append([]byte{0xef, 0x01, 0x00}, make([]byte, 20)...), // 7702 delegation
		isValidSigResult: [4]byte{0xff, 0xff, 0xff, 0xff},                       // rejects
	}
	valid, err := VerifySignatureStrict(context.Background(), mock, eoa.Hex(), hash32, sig)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if valid {
		// This is the exact divergence our experiments demonstrated:
		// pre-verify must NOT accept sigs that on-chain would reject.
		t.Error("REGRESSION: 7702 EOA with rejecting delegate should return invalid — must match on-chain SignatureChecker")
	}
}

func TestVerifySignatureStrict_1271Reverts_ReturnsFalse_NoECDSAFallback(t *testing.T) {
	privKey, _ := crypto.GenerateKey()
	eoa := crypto.PubkeyToAddress(privKey.PublicKey)
	hash := crypto.Keccak256([]byte("test"))
	sig, _ := crypto.Sign(hash, privKey)
	sig[64] += 27

	var hash32 [32]byte
	copy(hash32[:], hash)

	// Address has code, isValidSignature reverts. Strict primitive must return false
	// with a non-nil error (propagated from EIP-1271) and must NOT fall back to ECDSA
	// (which would have returned true here). Callers use the non-nil error to distinguish
	// transient RPC failures from genuinely invalid signatures.
	mock := &mockStrictSigner{
		code:          []byte{0x60, 0x80},
		isValidSigErr: true, // reverts
	}
	valid, err := VerifySignatureStrict(context.Background(), mock, eoa.Hex(), hash32, sig)
	if err == nil {
		t.Fatal("expected non-nil error when isValidSignature reverts — callers need this to distinguish RPC failures from invalid sigs")
	}
	if valid {
		t.Error("must not ECDSA-fallback when isValidSignature reverts")
	}
}
