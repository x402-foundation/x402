package clientutil

import (
	"bytes"
	"context"
	"errors"
	"math/big"
	"testing"

	"github.com/ethereum/go-ethereum/common"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
)

const (
	testToken = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"
	testOwner = "0x1234567890123456789012345678901234567890"
)

type allowanceReadSigner struct {
	t      *testing.T
	result interface{}
	err    error
	calls  int
}

func (s *allowanceReadSigner) Address() string { return testOwner }

func (s *allowanceReadSigner) SignTypedData(
	context.Context, evm.TypedDataDomain, map[string][]evm.TypedDataField, string, map[string]interface{},
) ([]byte, error) {
	return nil, nil
}

func (s *allowanceReadSigner) ReadContract(
	_ context.Context, address string, abi []byte, functionName string, args ...interface{},
) (interface{}, error) {
	s.calls++
	if address != testToken || functionName != "allowance" || !bytes.Equal(abi, evm.ERC20AllowanceABI) {
		s.t.Fatalf("unexpected read: address=%s fn=%s", address, functionName)
	}
	if len(args) != 2 || args[0] != common.HexToAddress(testOwner) || args[1] != common.HexToAddress(evm.PERMIT2Address) {
		s.t.Fatalf("unexpected allowance args: %v", args)
	}
	return s.result, s.err
}

func TestHasSufficientPermit2Allowance(t *testing.T) {
	cases := []struct {
		name     string
		result   interface{}
		err      error
		required string
		want     bool
	}{
		{name: "allowance equals required", result: big.NewInt(100), required: "100", want: true},
		{name: "allowance exceeds required", result: big.NewInt(101), required: "100", want: true},
		{name: "allowance below required", result: big.NewInt(99), required: "100", want: false},
		{name: "read error", err: errors.New("rpc down"), required: "100", want: false},
		{name: "unexpected result type", result: "100", required: "100", want: false},
		{name: "empty required amount", result: big.NewInt(100), required: "", want: false},
		{name: "non-numeric required amount", result: big.NewInt(100), required: "abc", want: false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			signer := &allowanceReadSigner{t: t, result: tc.result, err: tc.err}
			got := HasSufficientPermit2Allowance(context.Background(), signer, testToken, testOwner, tc.required)
			if got != tc.want {
				t.Fatalf("got %v, want %v", got, tc.want)
			}
			if signer.calls != 1 {
				t.Fatalf("expected one ReadContract call, got %d", signer.calls)
			}
		})
	}
}
