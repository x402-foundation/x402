package client

import (
	"context"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
)

func TestCreatePaymentPayloadHonorsAdvertisedTransactionVersions(t *testing.T) {
	signer := newTestSigner(t)
	feePayer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	authorizer := solana.MustPrivateKeyFromBase58(mustNewKey(t)).PublicKey()
	scheme := NewUptoSvmScheme(signer)

	t.Run("[0] builds a v0 open", func(t *testing.T) {
		requirements := newRequirements(t, feePayer, authorizer, challengeOptions{})
		requirements.Extra[upto.ExtraTransactionVersions] = []interface{}{float64(0)}

		payload, err := scheme.CreatePaymentPayload(context.Background(), requirements, x402.PaymentPayloadContext{})
		require.NoError(t, err)
		decoded, err := svm.UptoPayloadFromMap(payload.Payload)
		require.NoError(t, err)
		tx, err := svm.DecodeTransaction(decoded.OpenTransaction)
		require.NoError(t, err)
		assert.Equal(t, solana.MessageVersionV0, tx.Message.GetVersion())
	})

	t.Run("a facilitator that accepts no buildable version is refused", func(t *testing.T) {
		requirements := newRequirements(t, feePayer, authorizer, challengeOptions{})
		requirements.Extra[upto.ExtraTransactionVersions] = []interface{}{float64(1)}

		_, err := scheme.CreatePaymentPayload(context.Background(), requirements, x402.PaymentPayloadContext{})
		require.Error(t, err)
		assert.Contains(t, err.Error(), svm.ErrUnsupportedTransactionVersion)
	})
}
