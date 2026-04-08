package facilitator

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"runtime"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"github.com/x402-foundation/x402/go/mechanisms/svm"
	"github.com/x402-foundation/x402/go/types"
)

type wrappedPaymentFixture struct {
	Name        string `json:"name"`
	Transaction string `json:"transaction"`
	Network     string `json:"network"`
	Asset       string `json:"asset"`
	PayTo       string `json:"payTo"`
	Amount      string `json:"amount"`
	FeePayer    string `json:"feePayer"`
	Payer       string `json:"payer"`
}

type mockFacilitatorSigner struct {
	addresses []solana.PublicKey
}

func (m *mockFacilitatorSigner) GetAddresses(context.Context, string) []solana.PublicKey {
	return m.addresses
}

func (m *mockFacilitatorSigner) SignTransaction(context.Context, *solana.Transaction, solana.PublicKey, string) error {
	return nil
}

func (m *mockFacilitatorSigner) SimulateTransaction(context.Context, *solana.Transaction, string) error {
	return nil
}

func (m *mockFacilitatorSigner) SendTransaction(context.Context, *solana.Transaction, string) (solana.Signature, error) {
	return solana.Signature{}, nil
}

func (m *mockFacilitatorSigner) ConfirmTransaction(context.Context, solana.Signature, string) error {
	return nil
}

func loadWrappedPaymentFixtures(t *testing.T) []wrappedPaymentFixture {
	t.Helper()

	_, currentFile, _, ok := runtime.Caller(0)
	require.True(t, ok)
	fixturePath := filepath.Join(filepath.Dir(currentFile), "..", "..", "testdata", "swig_wrapped_payments.json")
	fixtureBytes, err := os.ReadFile(fixturePath)
	require.NoError(t, err)

	var fixtures []wrappedPaymentFixture
	require.NoError(t, json.Unmarshal(fixtureBytes, &fixtures))
	return fixtures
}

func TestVerifySupportsBuiltInSwigTransfers(t *testing.T) {
	for _, fixture := range loadWrappedPaymentFixtures(t) {
		t.Run(fixture.Name, func(t *testing.T) {
			feePayer := solana.MustPublicKeyFromBase58(fixture.FeePayer)
			scheme := NewExactSvmScheme(&mockFacilitatorSigner{
				addresses: []solana.PublicKey{feePayer},
			})

			payload := types.PaymentPayload{
				X402Version: 2,
				Accepted: types.PaymentRequirements{
					Scheme:            svm.SchemeExact,
					Network:           fixture.Network,
					Asset:             fixture.Asset,
					Amount:            fixture.Amount,
					PayTo:             fixture.PayTo,
					MaxTimeoutSeconds: 300,
					Extra: map[string]interface{}{
						"feePayer": fixture.FeePayer,
					},
				},
				Payload: map[string]interface{}{
					"transaction": fixture.Transaction,
				},
			}

			response, err := scheme.Verify(context.Background(), payload, payload.Accepted, nil)
			require.NoError(t, err)
			assert.True(t, response.IsValid)
			assert.Equal(t, fixture.Payer, response.Payer)
		})
	}
}
