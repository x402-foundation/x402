package facilitator

import (
	"context"
	"errors"
	"math/big"
	"strings"
	"testing"
)

func chainID() *big.Int { return big.NewInt(8453) }

func TestVerifyBatchedVoucherTypedData_BadMaxClaimable(t *testing.T) {
	signer := &fakeFacilitatorSigner{}
	_, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		"0xabc", "not-a-number", "0xauth", "0xpayer", "0xdead", chainID())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestVerifyBatchedVoucherTypedData_BadChannelId(t *testing.T) {
	signer := &fakeFacilitatorSigner{}
	_, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		"not-hex", "100", "0xauth", "0xpayer", "0xdead", chainID())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestVerifyBatchedVoucherTypedData_BadSignature(t *testing.T) {
	signer := &fakeFacilitatorSigner{}
	_, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		"0xabcd", "100", "0xauth", "0xpayer", "not-hex", chainID())
	if err == nil {
		t.Fatal("expected error")
	}
}

func TestVerifyBatchedVoucherTypedData_RoutesToPayerAuthorizer(t *testing.T) {
	// payerAuthorizer != zero → uses VerifyEOATypedData (pure ECDSA, no signer calls).
	// The signature "0xdead" is only 2 bytes so ECDSA recovery fails → ok=false.
	// That's correct: if no valid 65-byte ECDSA sig is present, verification rejects.
	// The key assertion is that VerifyTypedData on the signer is NOT called.
	signer := &fakeFacilitatorSigner{}
	_, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		testErc3009ChannelId, "100",
		"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // payerAuthorizer
		"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", // payer
		"0xdead", chainID())
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	// VerifyTypedData on the signer must NOT be called (strict primitive uses ECDSA directly).
	if signer.verifyCalls != 0 {
		t.Fatalf("expected 0 verifyTypedData calls, got %d", signer.verifyCalls)
	}
}

func TestVerifyBatchedVoucherTypedData_RoutesToPayerWhenAuthorizerZero(t *testing.T) {
	// payerAuthorizer == zeroAddress → uses VerifyTypedDataStrict (code-routed).
	// GetCode returns nil (EOA) → ECDSA path → 2-byte sig → fails → ok=false, err=nil.
	// Assertion: signer.VerifyTypedData is NOT called (strict primitive routes independently).
	signer := &fakeFacilitatorSigner{
		readContract: func(fn string, _ ...interface{}) (interface{}, error) {
			if fn == "isValidSignature" {
				return [4]byte{0x16, 0x26, 0xba, 0x7e}, nil
			}
			return nil, errors.New("no rpc")
		},
	}
	_, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		testErc3009ChannelId, "100",
		zeroAddress,
		"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
		"0xdead", chainID())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if signer.verifyCalls != 0 {
		t.Fatalf("expected 0 verifyTypedData calls (strict primitive), got %d", signer.verifyCalls)
	}
}

func TestVerifyBatchedVoucherTypedData_RoutesToPayerWhenAuthorizerEmpty(t *testing.T) {
	// Same as RoutesToPayerWhenAuthorizerZero but with empty string payerAuthorizer.
	signer := &fakeFacilitatorSigner{
		readContract: func(fn string, _ ...interface{}) (interface{}, error) {
			if fn == "isValidSignature" {
				return [4]byte{0x16, 0x26, 0xba, 0x7e}, nil
			}
			return nil, errors.New("no rpc")
		},
	}
	_, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		testErc3009ChannelId, "100", "", "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "0xdead", chainID())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if signer.verifyCalls != 0 {
		t.Fatalf("expected 0 verifyTypedData calls (strict primitive), got %d", signer.verifyCalls)
	}
}

func TestReadChannelState_RpcFailure(t *testing.T) {
	signer := &fakeFacilitatorSigner{}
	_, err := ReadChannelState(context.Background(), signer, "0xabc")
	if err == nil {
		t.Fatal("expected RPC error")
	}
	if !strings.Contains(err.Error(), "multicall failed") {
		t.Fatalf("got %v", err)
	}
}
