package facilitator

import (
	"context"
	"encoding/binary"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

func TestVerifyRequiredSignatures_RejectsFeePayerMismatch(t *testing.T) {
	f := buildExactFixture(t)
	other := solana.NewWallet().PublicKey()
	err := VerifyRequiredSignatures(f.tx, other.String())
	require.Error(t, err)
	assert.Equal(t, ErrFeePayerMismatch, err.Error())
}

func TestVerifyRequiredSignatures_RejectsForgedClientSignature(t *testing.T) {
	f := buildExactFixture(t)
	forged := solana.Signature{}
	for i := range forged {
		forged[i] = byte(i + 1)
	}
	f.tx.Signatures[1] = forged
	err := VerifyRequiredSignatures(f.tx, f.facilitatorAddr.String())
	require.Error(t, err)
	assert.Equal(t, ErrSignatureInvalid, err.Error())
}

func TestVerifyRequiredSignatures_RejectsMissingClientSignature(t *testing.T) {
	f := buildExactFixture(t)
	f.tx.Signatures[1] = solana.Signature{}
	err := VerifyRequiredSignatures(f.tx, f.facilitatorAddr.String())
	require.Error(t, err)
	assert.Equal(t, ErrSignatureInvalid, err.Error())
}

func TestVerifyRequiredSignatures_AcceptsUnsignedFeePayerSlot(t *testing.T) {
	f := buildExactFixture(t)
	require.True(t, f.tx.Signatures[0].IsZero())
	require.NoError(t, VerifyRequiredSignatures(f.tx, f.facilitatorAddr.String()))
}

func TestExactSvmScheme_VerifyNeverSigns(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)

	resp, err := scheme.Verify(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 1, signer.simulateCalls)
}

func TestExactSvmScheme_SettleSignsOnce(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	signer := &mockExactSvmSigner{
		addresses:     []solana.PublicKey{facilitatorAddr},
		sendSignature: solana.SignatureFromBytes(append([]byte{9}, make([]byte, 63)...)),
	}
	scheme := NewExactSvmScheme(signer)

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, 1, signer.signCalls)
}

func TestExactSvmScheme_DuplicateSettleReturnsBeforeVerification(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)
	txKey := messageHashForPayload(t, payload)
	assert.False(t, scheme.settlementCache.IsDuplicate(txKey))

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrDuplicateSettlement, se.ErrorReason)
	assert.NotEmpty(t, se.Payer)
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 0, signer.simulateCalls)
	assert.Equal(t, 0, signer.sendCalls)
}

func TestExactSvmScheme_VerifyRejectsFeePayerMismatch(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	other := solana.NewWallet().PublicKey()
	requirements.Extra["feePayer"] = other.String()
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr, other}}
	scheme := NewExactSvmScheme(signer)

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrFeePayerMismatch, ve.InvalidReason)
	assert.Equal(t, 0, signer.signCalls)
}

func TestExactSvmScheme_MaxRequiredSignaturesRejected(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	maxSigs := uint8(1)
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer, &Config{MaxRequiredSignatures: &maxSigs})

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrExcessiveSigners, ve.InvalidReason)
}

func TestExactSvmScheme_ConfigPanicsOnZeroLimits(t *testing.T) {
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{solana.NewWallet().PublicKey()}}
	zero := uint32(0)
	assert.Panics(t, func() {
		NewExactSvmScheme(signer, &Config{MaxComputeUnits: &zero})
	})
	zeroSigs := uint8(0)
	assert.Panics(t, func() {
		NewExactSvmScheme(signer, &Config{MaxRequiredSignatures: &zeroSigs})
	})
}

func TestExactSvmScheme_ConfigPanicsWhenSmartWalletEnabledWithoutCapabilities(t *testing.T) {
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{solana.NewWallet().PublicKey()}}
	assert.Panics(t, func() {
		NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true})
	})
}

func TestExactSvmScheme_GetExtraFeaturesFlag(t *testing.T) {
	addr := solana.NewWallet().PublicKey()
	signer := &mockSmartWalletSigner{mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{addr}}}
	scheme := NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true})

	extra := scheme.GetExtra(x402.Network(svm.SolanaDevnetCAIP2))
	features, ok := extra["features"].(map[string]interface{})
	require.True(t, ok)
	assert.Equal(t, true, features["smartWalletSupported"])
}

func TestExactSvmScheme_LookupTableRejectedWithoutCapabilities(t *testing.T) {
	f := buildExactFixture(t)
	table := solana.NewWallet().PublicKey()
	f.tx.Message.SetVersion(solana.MessageVersionV0)
	f.tx.Message.AddressTableLookups = solana.MessageAddressTableLookupSlice{{
		AccountKey: table,
	}}
	require.NoError(t, f.tx.Message.SetAddressTables(map[solana.PublicKey]solana.PublicKeySlice{table: {}}))
	signTransaction(t, f.tx, f.ownerKey)
	encoded, err := svm.EncodeTransaction(f.tx)
	require.NoError(t, err)
	f.payload.Payload = (&svm.ExactSvmPayload{Transaction: encoded}).ToMap()

	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)
	_, verr := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, verr)
	require.True(t, errors.As(verr, &ve))
	assert.Contains(t, ve.InvalidReason, ErrSmartWalletAltResolutionUnavailable)
}

func TestExactSvmScheme_Path1AcceptsSevenLighthouseInstructions(t *testing.T) {
	f := buildExactFixtureWithOptional(t,
		lighthouseInstruction(),
		lighthouseInstruction(),
		lighthouseInstruction(),
		lighthouseInstruction(),
	)
	require.Equal(t, 7, len(f.tx.Message.Instructions))

	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)
	resp, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
}

func TestExactSvmScheme_Path1RejectsEightInstructions(t *testing.T) {
	f := buildExactFixtureWithOptional(t,
		lighthouseInstruction(),
		lighthouseInstruction(),
		lighthouseInstruction(),
		lighthouseInstruction(),
		lighthouseInstruction(),
	)
	require.Equal(t, 8, len(f.tx.Message.Instructions))

	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)
	_, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrTransactionInstructionsLength, ve.InvalidReason)
}

func TestExactSvmScheme_Path1RejectsOverpayment(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	requirements.Amount = "500"
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrAmountMismatch, ve.InvalidReason)
	assert.Equal(t, 0, signer.signCalls)
}

func TestGetTokenPayerFromTransaction_LookupProgramIndexDoesNotPanic(t *testing.T) {
	f := buildExactFixture(t)
	f.tx.Message.Instructions[2].ProgramIDIndex = uint16(len(f.tx.Message.AccountKeys) + 5)
	require.NotPanics(t, func() {
		_, err := svm.GetTokenPayerFromTransaction(f.tx)
		require.Error(t, err)
	})
}

func TestExactSvmScheme_DefaultLimits(t *testing.T) {
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{solana.NewWallet().PublicKey()}}
	scheme := NewExactSvmScheme(signer)
	// scheme_exact_svm.md §2.2.1 reference default and §2.1.4 signer set.
	assert.Equal(t, uint32(400_000), scheme.maxComputeUnits())
	assert.Equal(t, uint8(2), scheme.maxRequiredSignatures())

	f := buildExactFixture(t)
	limit := func(units uint32) solana.CompiledInstruction {
		data := make([]byte, 5)
		data[0] = ixSetComputeUnitLimit
		binary.LittleEndian.PutUint32(data[1:], units)
		return solana.CompiledInstruction{ProgramIDIndex: f.tx.Message.Instructions[0].ProgramIDIndex, Data: data}
	}
	require.NoError(t, scheme.verifyComputeLimitInstruction(f.tx, limit(400_000)))
	err := scheme.verifyComputeLimitInstruction(f.tx, limit(400_001))
	require.Error(t, err)
	assert.Equal(t, ErrComputeLimitInstructionTooHigh, err.Error())

	raised := uint32(1_400_000)
	assert.NoError(t, NewExactSvmScheme(signer, &Config{MaxComputeUnits: &raised}).verifyComputeLimitInstruction(f.tx, limit(1_400_000)))
}

func TestExactSvmScheme_ConfiguredTransactionVersions(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}

	narrowed := NewExactSvmScheme(signer, &Config{TransactionVersions: []int{1}})
	assert.Equal(t, []int{1}, narrowed.GetExtra(x402.Network(svm.SolanaDevnetCAIP2))[svm.ExtraTransactionVersions])
	_, err := narrowed.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrUnsupportedTransactionVersion, ve.InvalidReason)
	assert.Equal(t, 0, signer.simulateCalls)

	defaults := NewExactSvmScheme(signer)
	assert.Equal(t, []int{0, 1}, defaults.GetExtra(x402.Network(svm.SolanaDevnetCAIP2))[svm.ExtraTransactionVersions])

	for _, invalid := range [][]int{{}, {2}, {0, -1}} {
		assert.Panics(t, func() { NewExactSvmScheme(signer, &Config{TransactionVersions: invalid}) })
	}
}
