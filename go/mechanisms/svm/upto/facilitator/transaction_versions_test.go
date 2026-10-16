package facilitator

import (
	"context"
	"encoding/base64"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/upto"
)

func TestGetExtraAdvertisesTransactionVersions(t *testing.T) {
	scheme := newScheme(newMockSigner(t, 1), newStubRPC(t), nil)

	extra := scheme.GetExtra(testNetwork)
	assert.Equal(t, svm.AdvertisedTransactionVersions, extra[upto.ExtraTransactionVersions])
}

// encodeV1OpenTransaction returns a structurally valid, fully signed
// transaction-v1 wire payload. The upto facilitator only accepts legacy and
// v0 opens, so it must be refused by the version gate before any layout check.
func encodeV1OpenTransaction(t *testing.T) string {
	t.Helper()
	payer := solana.NewWallet()
	tx, err := solana.NewTransaction(
		[]solana.Instruction{solana.NewInstruction(solana.MemoProgramID, nil, []byte("v1 open"))},
		solana.Hash{},
		solana.TransactionPayer(payer.PublicKey()),
		solana.TransactionV1Config(solana.TransactionConfig{}.
			WithComputeUnitLimit(10_000).
			WithLoadedAccountsDataSizeLimit(65_536)),
	)
	require.NoError(t, err)
	_, err = tx.Sign(func(key solana.PublicKey) *solana.PrivateKey {
		if key.Equals(payer.PublicKey()) {
			return &payer.PrivateKey
		}
		return nil
	})
	require.NoError(t, err)
	raw, err := tx.MarshalBinary()
	require.NoError(t, err)
	return base64.StdEncoding.EncodeToString(raw)
}

// The spec requires a message version outside the accepted set to be rejected
// with unsupported_transaction_version, not the generic open-transaction reason.
func TestVerifyRejectsAVersion1OpenWithTheSpecReason(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), nil)

	payload := fixture.withPayload(map[string]interface{}{"openTransaction": encodeV1OpenTransaction(t)})
	_, err := scheme.Verify(context.Background(), payload, fixture.requirements, nil)

	assert.Equal(t, svm.ErrUnsupportedTransactionVersion, verifyErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions(), "rejections never broadcast")
}

func TestSettleRejectsAVersion1OpenWithTheSpecReason(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), nil)

	payload := fixture.withPayload(map[string]interface{}{"openTransaction": encodeV1OpenTransaction(t)})
	_, err := scheme.Settle(context.Background(), payload, fixture.requirements, nil)

	assert.Equal(t, svm.ErrUnsupportedTransactionVersion, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions(), "rejections never broadcast")
}
