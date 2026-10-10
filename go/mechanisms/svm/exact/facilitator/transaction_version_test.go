package facilitator

import (
	"context"
	"encoding/base64"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// encodeV1Transaction creates a structurally valid v1 transaction. Exact
// clients currently advertise/build v0, so facilitator verification rejects it
// before applying v0-specific payment checks.
func encodeV1Transaction(t *testing.T) string {
	t.Helper()
	payer := solana.NewWallet()
	tx, err := solana.NewTransaction(
		[]solana.Instruction{solana.NewInstruction(solana.MemoProgramID, nil, []byte("v1"))},
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

func TestExactSvmScheme_GetExtraAdvertisesTransactionVersions(t *testing.T) {
	addr := solana.NewWallet().PublicKey()
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{addr}}
	scheme := NewExactSvmScheme(signer)

	extra := scheme.GetExtra(x402.Network(svm.SolanaDevnetCAIP2))
	assert.Equal(t, addr.String(), extra["feePayer"])
	assert.Equal(t, svm.AdvertisedTransactionVersions, extra[svm.ExtraTransactionVersions])
}

func TestExactSvmScheme_VerifyRejectsUnsupportedTransactionVersionBeforeSignatureChecks(t *testing.T) {
	f := buildExactFixture(t)
	f.tx.Message.SetVersion(solana.MessageVersionV0)
	signTransaction(t, f.tx, f.ownerKey)
	f.payload.Payload = (&svm.ExactSvmPayload{Transaction: encodeV1Transaction(t)}).ToMap()

	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)
	_, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrUnsupportedTransactionVersion, ve.InvalidReason)
	assert.Equal(t, svm.ErrUnsupportedTransactionVersion, ve.InvalidReason)
	assert.Contains(t, ve.InvalidMessage, "version 1")
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 0, signer.simulateCalls)
}

func TestExactSvmScheme_VerifyStillAcceptsLegacyAndV0(t *testing.T) {
	for _, version := range []solana.MessageVersion{solana.MessageVersionLegacy, solana.MessageVersionV0} {
		f := buildExactFixture(t)
		f.tx.Message.SetVersion(version)
		signTransaction(t, f.tx, f.ownerKey)
		encoded, err := svm.EncodeTransaction(f.tx)
		require.NoError(t, err)
		f.payload.Payload = (&svm.ExactSvmPayload{Transaction: encoded}).ToMap()

		signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
		scheme := NewExactSvmScheme(signer)
		resp, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
		require.NoError(t, err, "version %d", version)
		assert.True(t, resp.IsValid, "version %d", version)
	}
}

func TestExactSvmScheme_SettleRejectsUnsupportedTransactionVersionBeforeSigning(t *testing.T) {
	f := buildExactFixture(t)
	f.tx.Message.SetVersion(solana.MessageVersionV0)
	signTransaction(t, f.tx, f.ownerKey)
	f.payload.Payload = (&svm.ExactSvmPayload{Transaction: encodeV1Transaction(t)}).ToMap()

	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)
	_, err := scheme.Settle(context.Background(), f.payload, f.requirements, nil)
	var se *x402.SettleError
	require.Error(t, err)
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrUnsupportedTransactionVersion, se.ErrorReason)
	assert.Contains(t, se.ErrorMessage, "version 1")
	assert.Equal(t, 0, signer.signCalls)
}
