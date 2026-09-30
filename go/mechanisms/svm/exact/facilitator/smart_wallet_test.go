package facilitator

import (
	"context"
	"encoding/binary"
	"errors"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	computebudget "github.com/gagliardetto/solana-go/programs/compute-budget"
	"github.com/gagliardetto/solana-go/rpc"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/types"
)

var squadsV4 = solana.MustPublicKeyFromBase58("SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf")

type mockSmartWalletSigner struct {
	mockExactSvmSigner
	inner            []rpc.InnerInstruction
	simulateInnerErr error
	confirmedInner   []rpc.InnerInstruction
	confirmedKeys    solana.PublicKeySlice
	confirmedErr     error
	tokenBalances    map[string]uint64
	lookupTables     map[solana.PublicKey]solana.PublicKeySlice
	lookupErr        error
}

func (m *mockSmartWalletSigner) SimulateTransactionWithInnerInstructions(_ context.Context, _ *solana.Transaction, _ string) ([]rpc.InnerInstruction, error) {
	if m.simulateInnerErr != nil {
		return nil, m.simulateInnerErr
	}
	return m.inner, nil
}

func (m *mockSmartWalletSigner) GetConfirmedTransactionInnerInstructions(_ context.Context, _ solana.Signature, _ string) ([]rpc.InnerInstruction, solana.PublicKeySlice, error) {
	if m.confirmedErr != nil {
		return nil, nil, m.confirmedErr
	}
	return m.confirmedInner, m.confirmedKeys, nil
}

func (m *mockSmartWalletSigner) GetTokenAccountBalance(_ context.Context, tokenAccount solana.PublicKey, _ string) (uint64, bool, error) {
	if m.tokenBalances == nil {
		return 0, false, nil
	}
	bal, ok := m.tokenBalances[tokenAccount.String()]
	return bal, ok, nil
}

func (m *mockSmartWalletSigner) FetchAddressLookupTables(_ context.Context, tables []solana.PublicKey, _ string) (map[solana.PublicKey]solana.PublicKeySlice, error) {
	if m.lookupErr != nil {
		return nil, m.lookupErr
	}
	if m.lookupTables != nil {
		return m.lookupTables, nil
	}
	out := make(map[solana.PublicKey]solana.PublicKeySlice, len(tables))
	for _, table := range tables {
		out[table] = nil
	}
	return out, nil
}

var _ svm.SmartWalletRPCCapabilities = (*mockSmartWalletSigner)(nil)

type smartWalletFixture struct {
	payload         types.PaymentPayload
	requirements    types.PaymentRequirements
	facilitatorAddr solana.PublicKey
	owner           solana.PublicKey
	tx              *solana.Transaction
	destATA         solana.PublicKey
	inner           rpc.InnerInstruction
}

func buildSmartWalletFixture(t *testing.T, walletProgram solana.PublicKey, cuLimit uint32) smartWalletFixture {
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

	limitIx, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
		SetUnits(cuLimit).
		ValidateAndBuild()
	require.NoError(t, err)
	priceIx, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().
		SetMicroLamports(1000).
		ValidateAndBuild()
	require.NoError(t, err)

	walletIx := solana.NewInstruction(
		walletProgram,
		solana.AccountMetaSlice{
			solana.NewAccountMeta(sourceATA, true, false),
			solana.NewAccountMeta(mint, false, false),
			solana.NewAccountMeta(destATA, true, false),
			solana.NewAccountMeta(owner, true, true),
			solana.NewAccountMeta(solana.TokenProgramID, false, false),
		},
		[]byte{0},
	)

	blockhash, err := solana.HashFromBase58("5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF")
	require.NoError(t, err)

	tx, err := solana.NewTransactionBuilder().
		AddInstruction(limitIx).
		AddInstruction(priceIx).
		AddInstruction(walletIx).
		SetRecentBlockHash(blockhash).
		SetFeePayer(facilitatorAddr).
		Build()
	require.NoError(t, err)
	signTransaction(t, tx, ownerWallet.PrivateKey)

	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)

	requirements := types.PaymentRequirements{
		Scheme:  svm.SchemeExact,
		Network: svm.SolanaDevnetCAIP2,
		Asset:   mint.String(),
		Amount:  "1000",
		PayTo:   payTo.String(),
		Extra: map[string]interface{}{
			"feePayer": facilitatorAddr.String(),
		},
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     (&svm.ExactSvmPayload{Transaction: encoded}).ToMap(),
		Accepted:    requirements,
	}

	mustIndex := func(key solana.PublicKey) uint16 {
		idx, idxErr := tx.GetAccountIndex(key)
		require.NoError(t, idxErr)
		return idx
	}
	data := make([]byte, 10)
	data[0] = ixTokenTransferChecked
	binary.LittleEndian.PutUint64(data[1:9], 1000)
	data[9] = 6
	inner := rpc.InnerInstruction{
		Index: 2,
		Instructions: []rpc.CompiledInstruction{{
			ProgramIDIndex: mustIndex(solana.TokenProgramID),
			Accounts: []uint16{
				mustIndex(sourceATA),
				mustIndex(mint),
				mustIndex(destATA),
				mustIndex(owner),
			},
			Data: solana.Base58(data),
		}},
	}

	return smartWalletFixture{
		payload:         payload,
		requirements:    requirements,
		facilitatorAddr: facilitatorAddr,
		owner:           owner,
		tx:              tx,
		destATA:         destATA,
		inner:           inner,
	}
}

func TestExactSvmScheme_SmartWalletPath2Accepted(t *testing.T) {
	f := buildSmartWalletFixture(t, squadsV4, 200_000)
	signer := &mockSmartWalletSigner{
		mockExactSvmSigner: mockExactSvmSigner{
			addresses:     []solana.PublicKey{f.facilitatorAddr},
			sendSignature: solana.SignatureFromBytes(append([]byte{7}, make([]byte, 63)...)),
		},
		inner:          []rpc.InnerInstruction{f.inner},
		confirmedInner: []rpc.InnerInstruction{f.inner},
		confirmedKeys:  f.tx.Message.AccountKeys,
		tokenBalances:  map[string]uint64{f.destATA.String(): 1000},
	}
	scheme := NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true})

	resp, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.IsValid)
	assert.Equal(t, f.owner.String(), resp.Payer)
	assert.Equal(t, 0, signer.signCalls)
	assert.Equal(t, 0, signer.simulateCalls)

	settle, err := scheme.Settle(context.Background(), f.payload, f.requirements, nil)
	require.NoError(t, err)
	assert.True(t, settle.Success)
	assert.Equal(t, 1, signer.signCalls)
}

func TestExactSvmScheme_SmartWalletDisallowedProgramRejected(t *testing.T) {
	f := buildSmartWalletFixture(t, solana.SystemProgramID, 200_000)
	signer := &mockSmartWalletSigner{
		mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}},
		inner:              []rpc.InnerInstruction{f.inner},
	}
	scheme := NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true})

	_, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Contains(t, ve.InvalidReason, ErrSmartWalletProgramNotAllowed)
}

func TestExactSvmScheme_SmartWalletComputeUnitsTooHigh(t *testing.T) {
	f := buildSmartWalletFixture(t, squadsV4, 500_000)
	signer := &mockSmartWalletSigner{
		mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}},
		inner:              []rpc.InnerInstruction{f.inner},
	}
	scheme := NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true})

	_, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Contains(t, ve.InvalidReason, ErrSmartWalletComputeUnitsTooHigh)
}

func TestExactSvmScheme_SmartWalletFeePayerIsolationRebuilt(t *testing.T) {
	facilitatorAddr := solana.NewWallet().PublicKey()
	ownerWallet := solana.NewWallet()
	owner := ownerWallet.PublicKey()
	mint := solana.NewWallet().PublicKey()
	payTo := solana.NewWallet().PublicKey()
	sourceATA, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	require.NoError(t, err)
	destATA, _, err := solana.FindAssociatedTokenAddress(payTo, mint)
	require.NoError(t, err)

	limitIx, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().SetUnits(200_000).ValidateAndBuild()
	require.NoError(t, err)
	priceIx, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().SetMicroLamports(1000).ValidateAndBuild()
	require.NoError(t, err)
	walletIx := solana.NewInstruction(
		squadsV4,
		solana.AccountMetaSlice{
			solana.NewAccountMeta(facilitatorAddr, false, false),
			solana.NewAccountMeta(sourceATA, true, false),
			solana.NewAccountMeta(mint, false, false),
			solana.NewAccountMeta(destATA, true, false),
			solana.NewAccountMeta(owner, true, true),
		},
		[]byte{0},
	)
	blockhash, err := solana.HashFromBase58("5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF")
	require.NoError(t, err)
	tx, err := solana.NewTransactionBuilder().
		AddInstruction(limitIx).
		AddInstruction(priceIx).
		AddInstruction(walletIx).
		SetRecentBlockHash(blockhash).
		SetFeePayer(facilitatorAddr).
		Build()
	require.NoError(t, err)
	signTransaction(t, tx, ownerWallet.PrivateKey)
	encoded, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)

	requirements := types.PaymentRequirements{
		Scheme:  svm.SchemeExact,
		Network: svm.SolanaDevnetCAIP2,
		Asset:   mint.String(),
		Amount:  "1000",
		PayTo:   payTo.String(),
		Extra:   map[string]interface{}{"feePayer": facilitatorAddr.String()},
	}
	payload := types.PaymentPayload{
		X402Version: 2,
		Payload:     (&svm.ExactSvmPayload{Transaction: encoded}).ToMap(),
		Accepted:    requirements,
	}
	signer := &mockSmartWalletSigner{
		mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}},
	}
	scheme := NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true})
	_, verr := scheme.Verify(context.Background(), payload, requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, verr)
	require.True(t, errors.As(verr, &ve))
	assert.Contains(t, ve.InvalidReason, ErrSmartWalletFeePayerNotIsolated)
}

func TestExactSvmScheme_SmartWalletPriorityFeeTooHigh(t *testing.T) {
	f := buildSmartWalletFixture(t, squadsV4, 200_000)
	max := uint64(500)
	signer := &mockSmartWalletSigner{
		mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}},
		inner:              []rpc.InnerInstruction{f.inner},
	}
	scheme := NewExactSvmScheme(signer, &Config{
		EnableSmartWalletVerification:          true,
		SmartWalletMaxPriorityFeeMicroLamports: &max,
	})

	_, err := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	var ve *x402.VerifyError
	require.Error(t, err)
	require.True(t, errors.As(err, &ve))
	assert.Contains(t, ve.InvalidReason, ErrSmartWalletPriorityFeeTooHigh)
}

func TestExactSvmScheme_LookupTableResolvedWhenSignerSupportsIt(t *testing.T) {
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

	signer := &mockSmartWalletSigner{
		mockExactSvmSigner: mockExactSvmSigner{addresses: []solana.PublicKey{f.facilitatorAddr}},
		lookupTables:       map[solana.PublicKey]solana.PublicKeySlice{table: {}},
	}
	scheme := NewExactSvmScheme(signer)

	resp, verr := scheme.Verify(context.Background(), f.payload, f.requirements, nil)
	require.NoError(t, verr)
	assert.True(t, resp.IsValid)
}

func TestBalanceDeltaMeetsAmount(t *testing.T) {
	tests := []struct {
		name     string
		after    uint64
		before   uint64
		required uint64
		want     bool
	}{
		{name: "sufficient increase", after: 2000, before: 1000, required: 1000, want: true},
		{name: "increase exceeds required", after: 2500, before: 1000, required: 1000, want: true},
		{name: "unchanged balance", after: 1000, before: 1000, required: 1000, want: false},
		{name: "insufficient increase", after: 1500, before: 1000, required: 1000, want: false},
		{name: "balance decrease does not wrap", after: 900, before: 1000, required: 1000, want: false},
		{name: "zero after lower than before", after: 0, before: 1, required: 1, want: false},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			assert.Equal(t, tt.want, balanceDeltaMeetsAmount(tt.after, tt.before, tt.required))
		})
	}
}

func TestExactSvmScheme_PostSettlementTOCTOUMiss(t *testing.T) {
	f := buildSmartWalletFixture(t, squadsV4, 200_000)
	signer := &mockSmartWalletSigner{
		mockExactSvmSigner: mockExactSvmSigner{
			addresses:     []solana.PublicKey{f.facilitatorAddr},
			sendSignature: solana.SignatureFromBytes(append([]byte{8}, make([]byte, 63)...)),
		},
		inner:          []rpc.InnerInstruction{f.inner},
		confirmedInner: []rpc.InnerInstruction{},
		confirmedKeys:  f.tx.Message.AccountKeys,
		tokenBalances:  map[string]uint64{f.destATA.String(): 0},
	}
	scheme := NewExactSvmScheme(signer, &Config{EnableSmartWalletVerification: true})

	_, err := scheme.Settle(context.Background(), f.payload, f.requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrPostSettlementTransferNotConfirmed, se.ErrorReason)
}
