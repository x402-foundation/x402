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

func retagMessageVersion(t *testing.T, tx *solana.Transaction, prefix byte) string {
	t.Helper()
	raw, err := tx.MarshalBinary()
	require.NoError(t, err)
	offset := 1 + 64*len(tx.Signatures)
	require.Equal(t, byte(0x80), raw[offset], "fixture must be a v0 transaction")
	raw[offset] = prefix
	return base64.StdEncoding.EncodeToString(raw)
}

func TestExactSvmSchemeV1_GetExtraAdvertisesTransactionVersions(t *testing.T) {
	addr := solana.NewWallet().PublicKey()
	scheme := NewExactSvmSchemeV1(&mockV1Signer{addresses: []solana.PublicKey{addr}})

	extra := scheme.GetExtra(x402.Network(svm.SolanaDevnetCAIP2))
	assert.Equal(t, addr.String(), extra["feePayer"])
	assert.Equal(t, svm.AdvertisedTransactionVersions, extra[svm.ExtraTransactionVersions])
}

func TestExactSvmSchemeV1_VerifyRejectsUnsupportedTransactionVersion(t *testing.T) {
	payload, requirements, facilitatorAddr, tx, ownerKey := buildV1Fixture(t)
	tx.Message.SetVersion(solana.MessageVersionV0)
	signV1Tx(t, tx, ownerKey)
	payload.Payload = (&svm.ExactSvmPayload{Transaction: retagMessageVersion(t, tx, 0x81)}).ToMap()

	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1(signer)
	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrUnsupportedTransactionVersion, ve.InvalidReason)
	assert.Contains(t, ve.InvalidMessage, "version 1")
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 0, signer.simulateCalls)
}

func TestExactSvmSchemeV1_SettleRejectsUnsupportedTransactionVersion(t *testing.T) {
	payload, requirements, facilitatorAddr, tx, ownerKey := buildV1Fixture(t)
	tx.Message.SetVersion(solana.MessageVersionV0)
	signV1Tx(t, tx, ownerKey)
	payload.Payload = (&svm.ExactSvmPayload{Transaction: retagMessageVersion(t, tx, 0x81)}).ToMap()

	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1(signer)
	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.Error(t, err)
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrUnsupportedTransactionVersion, se.ErrorReason)
	assert.Contains(t, se.ErrorMessage, "version 1")
	assert.Equal(t, 0, signer.signCalls)
}
