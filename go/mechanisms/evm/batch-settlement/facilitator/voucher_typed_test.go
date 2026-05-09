package facilitator

import (
	"context"
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
	signer := &fakeFacilitatorSigner{
		verifyTypedData: func(_ string) (bool, error) { return true, nil },
	}
	ok, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		"0xabcd", "100",
		"0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", // payerAuthorizer
		"0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", // payer
		"0xdead", chainID())
	if err != nil || !ok {
		t.Fatalf("ok=%v err=%v", ok, err)
	}
	if signer.verifyCalls != 1 || !strings.EqualFold(signer.verifyAddrs[0], "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa") {
		t.Fatalf("called with %+v", signer.verifyAddrs)
	}
}

func TestVerifyBatchedVoucherTypedData_RoutesToPayerWhenAuthorizerZero(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		verifyTypedData: func(_ string) (bool, error) { return true, nil },
	}
	_, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		"0xabcd", "100",
		zeroAddress,
		"0xpayer",
		"0xdead", chainID())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if signer.verifyCalls != 1 || signer.verifyAddrs[0] != "0xpayer" {
		t.Fatalf("called with %+v", signer.verifyAddrs)
	}
}

func TestVerifyBatchedVoucherTypedData_RoutesToPayerWhenAuthorizerEmpty(t *testing.T) {
	signer := &fakeFacilitatorSigner{
		verifyTypedData: func(_ string) (bool, error) { return true, nil },
	}
	_, err := VerifyBatchedVoucherTypedData(context.Background(), signer,
		"0xabcd", "100", "", "0xpayer", "0xdead", chainID())
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if signer.verifyAddrs[0] != "0xpayer" {
		t.Fatalf("called with %+v", signer.verifyAddrs)
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
