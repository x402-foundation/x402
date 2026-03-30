package client

import (
	"context"
	"math/big"
	"testing"

	goethtypes "github.com/ethereum/go-ethereum/core/types"

	"github.com/coinbase/x402/go/mechanisms/evm"
)

type rpcTestSigner struct {
	address       string
	signCalls     int
	nonceCalls    int
	estimateCalls int
}

func (s *rpcTestSigner) Address() string {
	if s.address == "" {
		return "0x1234567890123456789012345678901234567890"
	}
	return s.address
}

func (s *rpcTestSigner) SignTypedData(
	ctx context.Context,
	domain evm.TypedDataDomain,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	return []byte{1, 2, 3}, nil
}

func (s *rpcTestSigner) SignTransaction(ctx context.Context, tx *goethtypes.Transaction) ([]byte, error) {
	s.signCalls++
	return []byte{0x01}, nil
}

func (s *rpcTestSigner) GetTransactionCount(ctx context.Context, address string) (uint64, error) {
	s.nonceCalls++
	return 7, nil
}

func (s *rpcTestSigner) EstimateFeesPerGas(ctx context.Context) (*big.Int, *big.Int, error) {
	s.estimateCalls++
	return big.NewInt(100), big.NewInt(10), nil
}

func TestResolveRPCURL(t *testing.T) {
	scheme := &UptoEvmScheme{
		config: &UptoEvmSchemeConfig{
			RPCURL: "https://default.example",
			RPCByChainID: map[int64]UptoEvmChainConfig{
				8453: {RPCURL: "https://base.example"},
			},
		},
	}

	if got := scheme.resolveRPCURL("eip155:8453"); got != "https://base.example" {
		t.Fatalf("expected chain-specific rpc, got %q", got)
	}
	if got := scheme.resolveRPCURL("eip155:137"); got != "https://default.example" {
		t.Fatalf("expected default rpc, got %q", got)
	}
}

func TestResolveTxSignerUsesSignerCapabilitiesFirst(t *testing.T) {
	ctx := context.Background()
	signer := &rpcTestSigner{}
	scheme := &UptoEvmScheme{
		signer: signer,
	}

	txSigner, err := scheme.resolveTxSigner(ctx, "eip155:8453")
	if err != nil {
		t.Fatalf("resolveTxSigner failed: %v", err)
	}
	if txSigner == nil {
		t.Fatal("expected tx signer")
	}

	_, err = txSigner.SignTransaction(ctx, nil)
	if err != nil {
		t.Fatalf("SignTransaction failed: %v", err)
	}
	_, err = txSigner.GetTransactionCount(ctx, signer.Address())
	if err != nil {
		t.Fatalf("GetTransactionCount failed: %v", err)
	}
	_, _, err = txSigner.EstimateFeesPerGas(ctx)
	if err != nil {
		t.Fatalf("EstimateFeesPerGas failed: %v", err)
	}

	if signer.signCalls != 1 || signer.nonceCalls != 1 || signer.estimateCalls != 1 {
		t.Fatalf("expected signer methods to be used, got sign=%d nonce=%d fee=%d", signer.signCalls, signer.nonceCalls, signer.estimateCalls)
	}
}

func TestResolveTxSignerReturnsNilWithoutRequiredCapabilities(t *testing.T) {
	ctx := context.Background()
	scheme := &UptoEvmScheme{
		signer: &mockMinimalClientSigner{},
	}

	txSigner, err := scheme.resolveTxSigner(ctx, "eip155:8453")
	if err != nil {
		t.Fatalf("resolveTxSigner failed: %v", err)
	}
	if txSigner != nil {
		t.Fatal("expected nil tx signer when signTransaction capability is missing")
	}
}

type mockMinimalClientSigner struct{}

func (m *mockMinimalClientSigner) Address() string {
	return "0x1234567890123456789012345678901234567890"
}

func (m *mockMinimalClientSigner) SignTypedData(
	ctx context.Context,
	domain evm.TypedDataDomain,
	types map[string][]evm.TypedDataField,
	primaryType string,
	message map[string]interface{},
) ([]byte, error) {
	return []byte{0x01}, nil
}

func TestScheme_ReturnsUpto(t *testing.T) {
	signer := &mockMinimalClientSigner{}
	scheme := NewUptoEvmScheme(signer, nil)

	if scheme.Scheme() != "upto" {
		t.Fatalf("expected scheme 'upto', got %q", scheme.Scheme())
	}
}
