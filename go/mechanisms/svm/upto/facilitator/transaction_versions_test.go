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
	assert.Equal(t, []int{0, 1}, extra[upto.ExtraTransactionVersions])
}

func newV1PaymentFixture(t *testing.T, signer *mockSigner) *paymentFixture {
	t.Helper()
	authorizer, err := solana.NewRandomPrivateKey()
	require.NoError(t, err)
	return newPaymentFixtureWithVersion(t, signer, authorizer, solana.MessageVersionV1)
}

// unknownVersionOpen relabels the fixture's v1 open as version 2, a format
// no verifier models.
func unknownVersionOpen(t *testing.T, fixture *paymentFixture) string {
	t.Helper()
	open, ok := fixture.payload.Payload["openTransaction"].(string)
	require.True(t, ok)
	raw, err := base64.StdEncoding.DecodeString(open)
	require.NoError(t, err)
	require.Equal(t, byte(0x81), raw[0])
	raw[0] = 0x82
	return base64.StdEncoding.EncodeToString(raw)
}

func TestVerifyAcceptsAVersion1Open(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newV1PaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), nil)

	response, err := scheme.Verify(context.Background(), fixture.payload, fixture.requirements, nil)
	require.NoError(t, err)
	assert.True(t, response.IsValid)
	assert.Equal(t, fixture.payerKey.PublicKey().String(), response.Payer)
}

func TestDepositSettleBroadcastsAVersion1Open(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newV1PaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	signer.onSend = func(*solana.Transaction) {
		stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	}

	response, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	require.NoError(t, err)
	assert.True(t, response.Success)
	require.Len(t, signer.sentTransactions(), 1)
	assert.Equal(t, solana.MessageVersionV1, signer.sentTransactions()[0].Message.GetVersion())
}

// The spec requires a message version outside the accepted set to be rejected
// with unsupported_transaction_version, not the generic open-transaction reason.
func TestVerifyRejectsAnUnknownVersionOpenWithTheSpecReason(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newV1PaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), nil)

	payload := fixture.withPayload(map[string]interface{}{"openTransaction": unknownVersionOpen(t, fixture)})
	_, err := scheme.Verify(context.Background(), payload, fixture.requirements, nil)

	assert.Equal(t, svm.ErrUnsupportedTransactionVersion, verifyErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions(), "rejections never broadcast")
}

func TestSettleRejectsAnUnknownVersionOpenWithTheSpecReason(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newV1PaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), nil)

	payload := fixture.withPayload(map[string]interface{}{"openTransaction": unknownVersionOpen(t, fixture)})
	_, err := scheme.Settle(context.Background(), payload, fixture.requirements, nil)

	assert.Equal(t, svm.ErrUnsupportedTransactionVersion, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions(), "rejections never broadcast")
}

// A facilitator configured to accept [0] refuses a version-1 open before any
// instruction is inspected, and advertises the configured set.
func TestVerifyEnforcesTheConfiguredAcceptedVersions(t *testing.T) {
	signer := newMockSigner(t, 1)
	fixture := newV1PaymentFixture(t, signer)
	scheme := newScheme(signer, newStubRPC(t), &Config{TransactionVersions: []int{0}})

	assert.Equal(t, []int{0}, scheme.GetExtra(testNetwork)[upto.ExtraTransactionVersions])
	_, err := scheme.Verify(context.Background(), fixture.payload, fixture.requirements, nil)
	assert.Equal(t, svm.ErrUnsupportedTransactionVersion, verifyErrorReason(t, err))
	assert.Panics(t, func() { NewUptoSvmScheme(signer, &Config{TransactionVersions: []int{2}}) })
}
