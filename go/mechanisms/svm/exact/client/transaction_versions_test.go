package client

import (
	"context"
	"net/http/httptest"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

func TestCreatePaymentPayloadHonorsAdvertisedTransactionVersions(t *testing.T) {
	server := httptest.NewServer(mockSolanaRPCHandler(t, func() string { return fixedBlockhash }))
	defer server.Close()

	newRequirements := func(versions interface{}) types.PaymentRequirements {
		extra := map[string]interface{}{
			"feePayer":        solana.NewWallet().PublicKey().String(),
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
	}{
		{name: "absent field builds v0", versions: nil},
		{name: "[0] builds v0", versions: []interface{}{float64(0)}},
		{name: "[\"legacy\",0] still builds v0: clients never build legacy", versions: []interface{}{"legacy", float64(0)}},
	} {
		t.Run(test.name, func(t *testing.T) {
			client := NewExactSvmScheme(&mockClientSigner{keypair: solana.NewWallet().PrivateKey}, &svm.ClientConfig{RPCURL: server.URL})
			payload, err := client.CreatePaymentPayload(context.Background(), newRequirements(test.versions))
			require.NoError(t, err)
			decoded, err := svm.DecodeTransaction(payload.Payload["transaction"].(string))
			require.NoError(t, err)
			assert.Equal(t, solana.MessageVersionV0, decoded.Message.GetVersion())
		})
	}

	t.Run("a facilitator that accepts no buildable version is refused before signing", func(t *testing.T) {
		client := NewExactSvmScheme(&mockClientSigner{keypair: solana.NewWallet().PrivateKey}, &svm.ClientConfig{RPCURL: server.URL})
		_, err := client.CreatePaymentPayload(context.Background(), newRequirements([]interface{}{float64(1)}))
		require.Error(t, err)
		assert.Contains(t, err.Error(), svm.ErrUnsupportedTransactionVersion)
	})
}
