package facilitator

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// schemeOnlySigner implements every UptoFacilitatorSigner method and omits
// GetProgramAccounts, so construction succeeds and Discover panics.
type schemeOnlySigner struct{}

func (schemeOnlySigner) GetAddresses(context.Context, string) []solana.PublicKey {
	return nil
}

func (schemeOnlySigner) SignTransaction(context.Context, *solana.Transaction, solana.PublicKey, string) error {
	return nil
}

func (schemeOnlySigner) SimulateTransaction(context.Context, *solana.Transaction, string) error {
	return nil
}

func (schemeOnlySigner) SendTransaction(context.Context, *solana.Transaction, string) (solana.Signature, error) {
	return solana.Signature{}, nil
}

func (schemeOnlySigner) ConfirmTransaction(context.Context, solana.Signature, string) error {
	return nil
}

func (schemeOnlySigner) GetAccountInfo(context.Context, solana.PublicKey, string, *rpc.GetAccountInfoOpts) (*rpc.GetAccountInfoResult, error) {
	return nil, nil
}

func (schemeOnlySigner) GetLatestBlockhash(context.Context, string) (solana.Hash, uint64, error) {
	return solana.Hash{}, 0, nil
}

func (schemeOnlySigner) GetSlot(context.Context, string, rpc.CommitmentType) (uint64, error) {
	return 0, nil
}

func (schemeOnlySigner) SimulateTransactionWithOpts(context.Context, *solana.Transaction, string, *rpc.SimulateTransactionOpts) error {
	return nil
}

var (
	_ svm.FacilitatorSvmSigner = schemeOnlySigner{}
	_ UptoFacilitatorSigner    = schemeOnlySigner{}
)

func TestNewUptoSvmSchemeAllowsSignerWithoutGetProgramAccounts(t *testing.T) {
	assert.NotPanics(t, func() {
		NewUptoSvmScheme(schemeOnlySigner{}, nil)
	})
}

func TestDiscoverRequiresGetProgramAccounts(t *testing.T) {
	manager := NewRentCleanupManager(RentCleanupConfig{
		Signer:  schemeOnlySigner{},
		Storage: NewInMemoryChannelStorage(),
		Network: testNetwork,
	})
	assert.PanicsWithValue(t, "RentCleanupManager.Discover requires GetProgramAccounts on the signer", func() {
		_ = manager.Discover(context.Background(), DiscoveryOptions{})
	})
}
