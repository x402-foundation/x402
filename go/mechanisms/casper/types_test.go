package casper

import (
	"context"
	"testing"

	caspertypes "github.com/make-software/casper-go-sdk/v2/types"
)

func TestNetworkConfigs(t *testing.T) {
	mainnet, ok := NetworkConfigs[CasperMainnetCAIP2]
	if !ok {
		t.Fatal("mainnet config not found")
	}
	if mainnet.ChainName != "casper" {
		t.Errorf("ChainName = %q, want %q", mainnet.ChainName, "casper")
	}
	if mainnet.RPCURL == "" {
		t.Error("RPCURL must not be empty")
	}

	testnet, ok := NetworkConfigs[CasperTestnetCAIP2]
	if !ok {
		t.Fatal("testnet config not found")
	}
	if testnet.ChainName != "casper-test" {
		t.Errorf("ChainName = %q, want %q", testnet.ChainName, "casper-test")
	}
}

func TestClientCasperSignerInterface(t *testing.T) {
	var _ ClientCasperSigner = (*mockClientSigner)(nil)
}

type mockClientSigner struct{}

func (m *mockClientSigner) AccountAddress() string { return "" }
func (m *mockClientSigner) PublicKey() string      { return "" }
func (m *mockClientSigner) SignEIP712(_ [32]byte) ([65]byte, error) {
	return [65]byte{}, nil
}

func TestFacilitatorCasperSignerInterface(t *testing.T) {
	var _ FacilitatorCasperSigner = (*mockFacilitatorSigner)(nil)
}

type mockFacilitatorSigner struct{}

func (m *mockFacilitatorSigner) GetNetworkConfig(_ context.Context, _ string) (NetworkConfig, error) {
	return NetworkConfig{}, nil
}
func (m *mockFacilitatorSigner) GetAddresses(_ context.Context, _ string) []string { return nil }
func (m *mockFacilitatorSigner) GetPublicKeyHex(_ context.Context, _ string) (string, error) {
	return "", nil
}
func (m *mockFacilitatorSigner) VerifyEIP712Signature(_ [32]byte, _ [65]byte, _ string) (bool, error) {
	return true, nil
}
func (m *mockFacilitatorSigner) SignTransaction(_ *caspertypes.TransactionV1, _ string) error {
	return nil
}
func (m *mockFacilitatorSigner) SignDeploy(_ *caspertypes.Deploy, _ string) error {
	return nil
}
func (m *mockFacilitatorSigner) GetSpeculativeRpcUrl(_ string) string { return "" }
func (m *mockFacilitatorSigner) PutTransaction(_ context.Context, _ string, _ caspertypes.TransactionV1) (string, error) {
	return "", nil
}
func (m *mockFacilitatorSigner) WaitForTransaction(_ context.Context, _ string, _ string) error {
	return nil
}
