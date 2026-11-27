package client

import (
	"context"
	"net/http/httptest"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	exactfacilitator "github.com/x402-foundation/x402/go/v2/mechanisms/svm/exact/facilitator"
	"github.com/x402-foundation/x402/go/v2/types"
)

// roundTripFacilitatorSigner is a FacilitatorSvmSigner whose simulation
// always succeeds, so Verify runs every structural check against the
// client-built transaction.
type roundTripFacilitatorSigner struct{ address solana.PublicKey }

func (s *roundTripFacilitatorSigner) GetAddresses(context.Context, string) []solana.PublicKey {
	return []solana.PublicKey{s.address}
}
func (s *roundTripFacilitatorSigner) SignTransaction(context.Context, *solana.Transaction, solana.PublicKey, string) error {
	return nil
}
func (s *roundTripFacilitatorSigner) SimulateTransaction(context.Context, *solana.Transaction, string, *svm.FacilitatorSimulateTransactionOptions) error {
	return nil
}
func (s *roundTripFacilitatorSigner) SendTransaction(context.Context, *solana.Transaction, string) (solana.Signature, error) {
	return solana.Signature{}, nil
}
func (s *roundTripFacilitatorSigner) ConfirmTransaction(context.Context, solana.Signature, string) error {
	return nil
}

func TestCreatePaymentPayloadHonorsAdvertisedTransactionVersions(t *testing.T) {
	server := httptest.NewServer(mockSolanaRPCHandler(t, func() string { return fixedBlockhash }))
	defer server.Close()

	newRequirements := func(feePayer solana.PublicKey, versions interface{}) types.PaymentRequirements {
		extra := map[string]interface{}{
			"feePayer":        feePayer.String(),
			"recentBlockhash": fixedBlockhash,
		}
		if versions != nil {
			extra[svm.ExtraTransactionVersions] = versions
		}
		return types.PaymentRequirements{
			Scheme:            "exact",
			Network:           "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
			Asset:             "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
			Amount:            "100000",
			PayTo:             solana.NewWallet().PublicKey().String(),
			MaxTimeoutSeconds: 3600,
			Extra:             extra,
		}
	}

	for _, test := range []struct {
		name     string
		versions interface{}
		client   []int
		want     solana.MessageVersion
	}{
		{name: "absent field builds v0", versions: nil, want: solana.MessageVersionV0},
		{name: "[0] builds v0", versions: []interface{}{float64(0)}, want: solana.MessageVersionV0},
		{name: "[1,0] builds v1", versions: []interface{}{float64(1), float64(0)}, want: solana.MessageVersionV1},
		{name: "[1] builds v1", versions: []interface{}{float64(1)}, want: solana.MessageVersionV1},
		{name: "a v0-only client builds v0 from [0,1]", versions: []interface{}{float64(0), float64(1)}, client: []int{0}, want: solana.MessageVersionV0},
	} {
		t.Run(test.name, func(t *testing.T) {
			feePayer := solana.NewWallet().PublicKey()
			requirements := newRequirements(feePayer, test.versions)
			client := NewExactSvmScheme(
				&mockClientSigner{keypair: solana.NewWallet().PrivateKey},
				&svm.ClientConfig{RPCURL: server.URL, TransactionVersions: test.client},
			)
			payload, err := client.CreatePaymentPayload(context.Background(), requirements, x402.PaymentPayloadContext{})
			require.NoError(t, err)
			decoded, err := svm.DecodeTransaction(payload.Payload["transaction"].(string))
			require.NoError(t, err)
			assert.Equal(t, test.want, decoded.Message.GetVersion())

			if test.want == solana.MessageVersionV1 {
				config := decoded.Message.TransactionConfig
				require.NotNil(t, config.ComputeUnitLimit)
				assert.Equal(t, svm.DefaultComputeUnitLimit, *config.ComputeUnitLimit)
				require.NotNil(t, config.LoadedAccountsDataSizeLimit)
				assert.Equal(t, svm.DefaultLoadedAccountsDataSizeLimit, *config.LoadedAccountsDataSizeLimit)
				require.NotNil(t, config.PriorityFee)
				assert.Equal(t, uint64(1), *config.PriorityFee, "1 microlamport/CU at 20,000 CU rounds up to 1 lamport")
				assert.Nil(t, config.HeapSize)
				require.Len(t, decoded.Message.Instructions, 2, "TransferChecked + Memo, no ComputeBudget instructions")
			}

			// The facilitator accepts what the client built.
			payload.Accepted = requirements
			resp, err := exactfacilitator.NewExactSvmScheme(&roundTripFacilitatorSigner{address: feePayer}).
				Verify(context.Background(), payload, requirements, nil)
			require.NoError(t, err)
			assert.True(t, resp.IsValid)
		})
	}

	t.Run("a facilitator that accepts no buildable version is refused before signing", func(t *testing.T) {
		client := NewExactSvmScheme(
			&mockClientSigner{keypair: solana.NewWallet().PrivateKey},
			&svm.ClientConfig{RPCURL: server.URL, TransactionVersions: []int{0}},
		)
		_, err := client.CreatePaymentPayload(context.Background(), newRequirements(solana.NewWallet().PublicKey(), []interface{}{float64(1)}), x402.PaymentPayloadContext{})
		require.Error(t, err)
		assert.Contains(t, err.Error(), svm.ErrUnsupportedTransactionVersion)
	})

	t.Run("an invalid client version set is refused", func(t *testing.T) {
		client := NewExactSvmScheme(
			&mockClientSigner{keypair: solana.NewWallet().PrivateKey},
			&svm.ClientConfig{RPCURL: server.URL, TransactionVersions: []int{2}},
		)
		_, err := client.CreatePaymentPayload(context.Background(), newRequirements(solana.NewWallet().PublicKey(), nil), x402.PaymentPayloadContext{})
		require.Error(t, err)
		assert.Contains(t, err.Error(), svm.ErrUnsupportedTransactionVersion)
	})
}
