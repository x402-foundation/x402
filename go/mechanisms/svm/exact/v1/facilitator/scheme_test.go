package facilitator

import (
	"context"
	"encoding/json"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/programs/token"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

type mockV1Signer struct {
	addresses     []solana.PublicKey
	signCalls     int
	simulateCalls int
	sendCalls     int
}

func (m *mockV1Signer) GetAddresses(_ context.Context, _ string) []solana.PublicKey {
	return m.addresses
}
func (m *mockV1Signer) SignTransaction(_ context.Context, _ *solana.Transaction, _ solana.PublicKey, _ string) error {
	m.signCalls++
	return nil
}
func (m *mockV1Signer) SimulateTransaction(_ context.Context, _ *solana.Transaction, _ string) error {
	m.simulateCalls++
	return nil
}
func (m *mockV1Signer) SendTransaction(_ context.Context, _ *solana.Transaction, _ string) (solana.Signature, error) {
	m.sendCalls++
	return solana.SignatureFromBytes(append([]byte{1}, make([]byte, 63)...)), nil
}
func (m *mockV1Signer) ConfirmTransaction(_ context.Context, _ solana.Signature, _ string) error {
	return nil
}

func signV1Tx(t *testing.T, tx *solana.Transaction, key solana.PrivateKey) {
	t.Helper()
	messageBytes, err := tx.Message.MarshalBinary()
	require.NoError(t, err)
	signature, err := key.Sign(messageBytes)
	require.NoError(t, err)
	index, err := tx.GetAccountIndex(key.PublicKey())
	require.NoError(t, err)
	n := int(tx.Message.Header.NumRequiredSignatures)
	if len(tx.Signatures) < n {
		sigs := make([]solana.Signature, n)
		copy(sigs, tx.Signatures)
		tx.Signatures = sigs
	}
	tx.Signatures[index] = signature
}

func buildV1Fixture(t *testing.T) (types.PaymentPayloadV1, types.PaymentRequirementsV1, solana.PublicKey, *solana.Transaction, solana.PrivateKey) {
	t.Helper()
	facilitatorAddr := solana.NewWallet().PublicKey()
	ownerWallet := solana.NewWallet()
	owner := ownerWallet.PublicKey()
	mint := solana.NewWallet().PublicKey()
	payTo := solana.NewWallet().PublicKey()

	sourceATA, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	require.NoError(t, err)
	destATA, _, err := solana.FindAssociatedTokenAddress(payTo, mint)
	require.NoError(t, err)

	cuLimit, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().SetUnits(200000).ValidateAndBuild()
	require.NoError(t, err)
	cuPrice, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().SetMicroLamports(1000).ValidateAndBuild()
	require.NoError(t, err)
	transferIx, err := token.NewTransferCheckedInstructionBuilder().
		SetAmount(1000).SetDecimals(6).
		SetSourceAccount(sourceATA).SetMintAccount(mint).
		SetDestinationAccount(destATA).SetOwnerAccount(owner).
		ValidateAndBuild()
	require.NoError(t, err)

	blockhash, err := solana.HashFromBase58("5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF")
	require.NoError(t, err)
	tx, err := solana.NewTransactionBuilder().
		AddInstruction(cuLimit).AddInstruction(cuPrice).AddInstruction(transferIx).
		SetRecentBlockHash(blockhash).SetFeePayer(facilitatorAddr).Build()
	require.NoError(t, err)
	signV1Tx(t, tx, ownerWallet.PrivateKey)

	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)
	extra, err := json.Marshal(map[string]string{"feePayer": facilitatorAddr.String()})
	require.NoError(t, err)
	raw := json.RawMessage(extra)
	requirements := types.PaymentRequirementsV1{
		Scheme:            svm.SchemeExact,
		Network:           "solana-devnet",
		Asset:             mint.String(),
		MaxAmountRequired: "1000",
		PayTo:             payTo.String(),
		Extra:             &raw,
	}
	payload := types.PaymentPayloadV1{
		X402Version: 1,
		Scheme:      svm.SchemeExact,
		Network:     "solana-devnet",
		Payload:     (&svm.ExactSvmPayload{Transaction: encoded}).ToMap(),
	}
	return payload, requirements, facilitatorAddr, tx, ownerWallet.PrivateKey
}

func TestExactSvmSchemeV1_VerifyNeverSigns(t *testing.T) {
	payload, requirements, facilitatorAddr, _, _ := buildV1Fixture(t)
	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1(signer)

	resp, err := scheme.Verify(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 1, signer.simulateCalls)
}

func TestExactSvmSchemeV1_LookupTableRejected(t *testing.T) {
	payload, requirements, facilitatorAddr, tx, ownerKey := buildV1Fixture(t)
	table := solana.NewWallet().PublicKey()
	tx.Message.SetVersion(solana.MessageVersionV0)
	tx.Message.AddressTableLookups = solana.MessageAddressTableLookupSlice{{
		AccountKey: table,
	}}
	require.NoError(t, tx.Message.SetAddressTables(map[solana.PublicKey]solana.PublicKeySlice{table: {}}))
	signV1Tx(t, tx, ownerKey)
	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)
	payload.Payload = (&svm.ExactSvmPayload{Transaction: encoded}).ToMap()

	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1(signer)
	_, verr := scheme.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, verr)
	require.True(t, errors.As(verr, &ve))
	assert.Equal(t, ErrTransactionCouldNotBeDecoded, ve.InvalidReason)
}

func TestExactSvmSchemeV1_VerifyRejectsOverpayment(t *testing.T) {
	payload, requirements, facilitatorAddr, _, _ := buildV1Fixture(t)
	requirements.MaxAmountRequired = "500"
	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1(signer)

	_, err := scheme.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Equal(t, ErrAmountMismatch, ve.InvalidReason)
	assert.Equal(t, 0, signer.signCalls)
}

func TestExactSvmSchemeV1_DuplicateSettleReturnsBeforeVerification(t *testing.T) {
	payload, requirements, facilitatorAddr, _, _ := buildV1Fixture(t)
	signer := &mockV1Signer{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmSchemeV1(signer)

	svmPayload, err := svm.PayloadFromMap(payload.Payload)
	require.NoError(t, err)
	tx, err := svm.DecodeTransaction(svmPayload.Transaction)
	require.NoError(t, err)
	txKey, err := svm.MessageHash(tx)
	require.NoError(t, err)
	assert.False(t, scheme.settlementCache.IsDuplicate(txKey))

	_, err = scheme.Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrDuplicateSettlement, se.ErrorReason)
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 0, signer.simulateCalls)
}
