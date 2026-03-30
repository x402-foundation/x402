package erc20approvalgassponsor

import (
	"context"
	"math/big"
	"testing"

	evm "github.com/coinbase/x402/go/mechanisms/evm"
)

type mockApprovalSigner struct {
	id string
}

func (m *mockApprovalSigner) GetAddresses() []string {
	return []string{"0x0000000000000000000000000000000000000001"}
}
func (m *mockApprovalSigner) ReadContract(_ context.Context, _ string, _ []byte, _ string, _ ...interface{}) (interface{}, error) {
	return big.NewInt(0), nil
}
func (m *mockApprovalSigner) VerifyTypedData(_ context.Context, _ string, _ evm.TypedDataDomain, _ map[string][]evm.TypedDataField, _ string, _ map[string]interface{}, _ []byte) (bool, error) {
	return true, nil
}
func (m *mockApprovalSigner) WriteContract(_ context.Context, _ string, _ []byte, _ string, _ ...interface{}) (string, error) {
	return "0xtx", nil
}
func (m *mockApprovalSigner) SendTransaction(_ context.Context, _ string, _ []byte) (string, error) {
	return "0xtx", nil
}
func (m *mockApprovalSigner) WaitForTransactionReceipt(_ context.Context, _ string) (*evm.TransactionReceipt, error) {
	return &evm.TransactionReceipt{Status: evm.TxStatusSuccess}, nil
}
func (m *mockApprovalSigner) GetBalance(_ context.Context, _ string, _ string) (*big.Int, error) {
	return big.NewInt(0), nil
}
func (m *mockApprovalSigner) GetChainID(_ context.Context) (*big.Int, error) {
	return big.NewInt(8453), nil
}
func (m *mockApprovalSigner) GetCode(_ context.Context, _ string) ([]byte, error) {
	return []byte{}, nil
}
func (m *mockApprovalSigner) SendTransactions(_ context.Context, _ []TransactionRequest) ([]string, error) {
	return []string{"0xtx"}, nil
}

func TestResolveSigner_UsesNetworkResolverFirst(t *testing.T) {
	defaultSigner := &mockApprovalSigner{id: "default"}
	baseSigner := &mockApprovalSigner{id: "base"}
	ext := &Erc20ApprovalFacilitatorExtension{
		Signer: baseSigner,
		SignerForNetwork: func(network string) Erc20ApprovalGasSponsoringSigner {
			if network == "eip155:8453" {
				return defaultSigner
			}
			return nil
		},
	}

	resolved := ext.ResolveSigner("eip155:8453")
	if resolved == nil || resolved.(*mockApprovalSigner).id != "default" {
		t.Fatalf("expected network-specific signer, got %#v", resolved)
	}

	resolved = ext.ResolveSigner("eip155:1")
	if resolved == nil || resolved.(*mockApprovalSigner).id != "base" {
		t.Fatalf("expected fallback base signer, got %#v", resolved)
	}
}
