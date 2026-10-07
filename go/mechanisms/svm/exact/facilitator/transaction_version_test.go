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

// retagMessageVersion re-encodes a signed v0 transaction with its version
// prefix byte replaced, producing a wire transaction that solana-go decodes
// with a message version the verifiers do not model.
func retagMessageVersion(t *testing.T, tx *solana.Transaction, prefix byte) string {
	t.Helper()
	raw, err := tx.MarshalBinary()
	require.NoError(t, err)
	offset := 1 + 64*len(tx.Signatures)
	require.Equal(t, byte(0x80), raw[offset], "fixture must be a v0 transaction")
	raw[offset] = prefix
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
	f.payload.Payload = (&svm.ExactSvmPayload{Transaction: retagMessageVersion(t, f.tx, 0x81)}).ToMap()

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
	f.payload.Payload = (&svm.ExactSvmPayload{Transaction: retagMessageVersion(t, f.tx, 0x81)}).ToMap()

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
