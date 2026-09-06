package facilitator

import (
	"context"
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

// mockExactSvmSigner is a fully-mocked FacilitatorSvmSigner: SignTransaction
// and SimulateTransaction are no-ops (Verify's structural checks run purely
// against the decoded transaction, no real signature/on-chain-state
// validation is needed), while SendTransaction/ConfirmTransaction are
// configurable so tests can force the settlement_pending / reconciliation
// paths deterministically.
type mockExactSvmSigner struct {
	addresses     []solana.PublicKey
	sendSignature solana.Signature
	sendErr       error
	confirmErr    error
	sendCalls     int
	signCalls     int
	simulateCalls int
	confirmCalls  int
	confirmedSigs []solana.Signature
}

func (m *mockExactSvmSigner) GetAddresses(_ context.Context, _ string) []solana.PublicKey {
	return m.addresses
}
func (m *mockExactSvmSigner) SignTransaction(_ context.Context, _ *solana.Transaction, _ solana.PublicKey, _ string) error {
	m.signCalls++
	return nil
}
func (m *mockExactSvmSigner) SimulateTransaction(_ context.Context, _ *solana.Transaction, _ string) error {
	m.simulateCalls++
	return nil
}
func (m *mockExactSvmSigner) SendTransaction(_ context.Context, _ *solana.Transaction, _ string) (solana.Signature, error) {
	m.sendCalls++
	if m.sendErr != nil {
		return solana.Signature{}, m.sendErr
	}
	return m.sendSignature, nil
}
func (m *mockExactSvmSigner) ConfirmTransaction(_ context.Context, sig solana.Signature, _ string) error {
	m.confirmCalls++
	m.confirmedSigs = append(m.confirmedSigs, sig)
	return m.confirmErr
}

// buildValidExactSvmFixture constructs a syntactically valid exact-SVM
// payment payload/requirements pair: ComputeLimit + ComputePrice +
// TransferChecked. The token owner signs; the fee-payer slot is left unsigned
// for the facilitator to fill at settle.
func buildValidExactSvmFixture(t *testing.T) (types.PaymentPayload, types.PaymentRequirements, solana.PublicKey) {
	t.Helper()
	f := buildExactFixture(t)
	return f.payload, f.requirements, f.facilitatorAddr
}

type exactFixture struct {
	payload         types.PaymentPayload
	requirements    types.PaymentRequirements
	facilitatorAddr solana.PublicKey
	ownerKey        solana.PrivateKey
	tx              *solana.Transaction
	mint            solana.PublicKey
	payTo           solana.PublicKey
	destATA         solana.PublicKey
}

func signTransaction(t *testing.T, tx *solana.Transaction, key solana.PrivateKey) {
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

func lighthouseInstruction() solana.Instruction {
	return solana.NewInstruction(
		solana.MustPublicKeyFromBase58(svm.LighthouseProgramAddress),
		solana.AccountMetaSlice{},
		[]byte{0x01},
	)
}

func buildExactFixture(t *testing.T) exactFixture {
	return buildExactFixtureWithOptional(t)
}

func buildExactFixtureWithOptional(t *testing.T, extra ...solana.Instruction) exactFixture {
	t.Helper()

	facilitatorAddr := solana.NewWallet().PrivateKey.PublicKey()
	ownerWallet := solana.NewWallet()
	owner := ownerWallet.PublicKey()
	mint := solana.NewWallet().PrivateKey.PublicKey()
	payTo := solana.NewWallet().PrivateKey.PublicKey()

	sourceATA, _, err := solana.FindAssociatedTokenAddress(owner, mint)
	require.NoError(t, err)
	destATA, _, err := solana.FindAssociatedTokenAddress(payTo, mint)
	require.NoError(t, err)

	cuLimit, err := computebudget.NewSetComputeUnitLimitInstructionBuilder().
		SetUnits(200000).
		ValidateAndBuild()
	require.NoError(t, err)

	cuPrice, err := computebudget.NewSetComputeUnitPriceInstructionBuilder().
		SetMicroLamports(1000).
		ValidateAndBuild()
	require.NoError(t, err)

	transferIx, err := token.NewTransferCheckedInstructionBuilder().
		SetAmount(1000).
		SetDecimals(6).
		SetSourceAccount(sourceATA).
		SetMintAccount(mint).
		SetDestinationAccount(destATA).
		SetOwnerAccount(owner).
		ValidateAndBuild()
	require.NoError(t, err)

	blockhash, err := solana.HashFromBase58("5Tx8F3jgSHx21CbtjwmdaKPLM5tWmreWAnPrbqHomSJF")
	require.NoError(t, err)

	builder := solana.NewTransactionBuilder().
		AddInstruction(cuLimit).
		AddInstruction(cuPrice).
		AddInstruction(transferIx)
	for _, ix := range extra {
		builder = builder.AddInstruction(ix)
	}
	tx, err := builder.
		SetRecentBlockHash(blockhash).
		SetFeePayer(facilitatorAddr).
		Build()
	require.NoError(t, err)

	signTransaction(t, tx, ownerWallet.PrivateKey)

	base64Tx, err := svm.EncodeTransaction(tx)
	require.NoError(t, err)

	svmPayload := &svm.ExactSvmPayload{Transaction: base64Tx}
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
		Payload:     svmPayload.ToMap(),
		Accepted:    requirements,
	}
	return exactFixture{
		payload:         payload,
		requirements:    requirements,
		facilitatorAddr: facilitatorAddr,
		ownerKey:        ownerWallet.PrivateKey,
		tx:              tx,
		mint:            mint,
		payTo:           payTo,
		destATA:         destATA,
	}
}

// Exercises the PendingSettlementStore fast path wired into ExactSvmScheme.Settle
// (see scheme.go): a settle attempt whose ConfirmTransaction wait fails must
// populate the store keyed by the transaction's message hash; a subsequent
// settle for the identical payload must hit that entry, skip
// verify/sign/send entirely, and reconcile against the already-broadcast
// signature via reconcilePendingSettlement. Mirrors the TS/Python SVM exact
// pending-settlement test suites.

func TestExactSvmScheme_PendingSettlementStore_CacheMissSuccessLeavesNoEntry(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	signer := &mockExactSvmSigner{
		addresses:     []solana.PublicKey{facilitatorAddr},
		sendSignature: solana.SignatureFromBytes(append([]byte{1}, make([]byte, 63)...)),
	}
	scheme := NewExactSvmScheme(signer)
	txKey := messageHashForPayload(t, payload)

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)

	_, ok, _ := scheme.pendingStore.Get(context.Background(), txKey)
	assert.False(t, ok, "successful settlement must not leave a pending entry")
}

func TestExactSvmScheme_PendingSettlementStore_CacheMissConfirmFailurePopulatesStore(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	wantSig := solana.SignatureFromBytes(append([]byte{2}, make([]byte, 63)...))
	signer := &mockExactSvmSigner{
		addresses:     []solana.PublicKey{facilitatorAddr},
		sendSignature: wantSig,
		confirmErr:    errors.New("rpc: confirmation timeout"),
	}
	scheme := NewExactSvmScheme(signer)
	txKey := messageHashForPayload(t, payload)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrSettlementPending, se.ErrorReason)
	assert.Equal(t, wantSig.String(), se.Transaction)

	stored, ok, _ := scheme.pendingStore.Get(context.Background(), txKey)
	require.True(t, ok, "confirm-wait failure must populate the pending-settlement store")
	assert.Equal(t, wantSig.String(), stored)

	// The dedup lock must survive a confirm-timeout: the transaction really
	// was broadcast, so a fresh Settle call for the same payload (landing
	// without a PendingSettlementStore, e.g. a different unaware caller, or
	// after the entry's TTL expires) must not be allowed to re-verify and
	// re-send. Mirrors TS/Go-upto, which both leave the lock in place here.
	_, held := scheme.settlementCache.Entries()[txKey]
	assert.True(t, held, "dedup lock must remain held after a confirm-timeout so a fresh settle can't re-send")
}

func TestExactSvmScheme_PendingSettlementStore_CacheHitReconcilesWithoutRebroadcast(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	priorSig := solana.SignatureFromBytes(append([]byte{3}, make([]byte, 63)...))
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)
	txKey := messageHashForPayload(t, payload)
	require.NoError(t, scheme.pendingStore.Set(context.Background(), txKey, priorSig.String()))

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
	assert.Equal(t, priorSig.String(), resp.Transaction)
	assert.Equal(t, 0, signer.sendCalls, "reconciliation fast path must never re-broadcast")
	assert.Equal(t, 1, signer.confirmCalls)

	_, ok, _ := scheme.pendingStore.Get(context.Background(), txKey)
	assert.False(t, ok, "successful reconciliation must clear the pending entry")
}

func TestExactSvmScheme_PendingSettlementStore_CacheHitStillPendingReturnsAgainWithoutRebroadcast(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	priorSig := solana.SignatureFromBytes(append([]byte{4}, make([]byte, 63)...))
	signer := &mockExactSvmSigner{
		addresses:  []solana.PublicKey{facilitatorAddr},
		confirmErr: errors.New("still pending"),
	}
	scheme := NewExactSvmScheme(signer)
	txKey := messageHashForPayload(t, payload)
	require.NoError(t, scheme.pendingStore.Set(context.Background(), txKey, priorSig.String()))

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrSettlementPending, se.ErrorReason)
	assert.Equal(t, priorSig.String(), se.Transaction)
	assert.Equal(t, 0, signer.sendCalls, "reconciliation fast path must never re-broadcast")

	stored, ok, _ := scheme.pendingStore.Get(context.Background(), txKey)
	require.True(t, ok)
	assert.Equal(t, priorSig.String(), stored)
}

func TestExactSvmScheme_PendingSettlementStore_TerminalVerifyFailureNeverTouchesStore(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	// Corrupt the requirements amount so Verify rejects with a terminal reason
	// (amount mismatch) before any signing/broadcasting occurs.
	requirements.Amount = "999999999"
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr}}
	scheme := NewExactSvmScheme(signer)
	txKey := messageHashForPayload(t, payload)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrAmountMismatch, se.ErrorReason)
	assert.Equal(t, 0, signer.sendCalls)

	_, ok, _ := scheme.pendingStore.Get(context.Background(), txKey)
	assert.False(t, ok)
}

// TestExactSvmScheme_SettlementCache_ReleasedOnTerminalFeePayerMismatch guards
// against the dedup lock leaking on a terminal (never-broadcast) failure
// reached after IsDuplicate has already claimed it. If the lock isn't
// released here, a legitimate retry of the identical payload (e.g. after the
// caller fixes the feePayer mismatch — or simply resubmits unchanged and
// expects the same terminal error, not a bogus "duplicate") would be wrongly
// rejected as a duplicate for the rest of the SettlementTTL window.
func TestExactSvmScheme_SettlementCache_ReleasedOnTerminalFeePayerMismatch(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	// Point requirements at a *different* facilitator-managed address than the
	// transaction's actual fee payer. Settle claims the dedup lock before
	// verify; verify then rejects AccountKeys[0] != extra.feePayer. The lock
	// must still be released so a retry is not a false duplicate.
	otherManagedAddr := solana.NewWallet().PrivateKey.PublicKey()
	requirements.Extra["feePayer"] = otherManagedAddr.String()
	signer := &mockExactSvmSigner{addresses: []solana.PublicKey{facilitatorAddr, otherManagedAddr}}
	scheme := NewExactSvmScheme(signer)
	txKey := messageHashForPayload(t, payload)

	_, err := scheme.Settle(context.Background(), payload, requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrFeePayerMismatch, se.ErrorReason)

	_, held := scheme.settlementCache.Entries()[txKey]
	assert.False(t, held, "dedup lock must be released on a terminal never-broadcast failure")

	// A retry of the identical payload must reach the same terminal error again,
	// not be rejected as a duplicate.
	_, err = scheme.Settle(context.Background(), payload, requirements, nil)
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrFeePayerMismatch, se.ErrorReason)
}

func TestExactSvmScheme_PendingSettlementStore_DefaultsToFreshInMemoryStoreWhenNoneInjected(t *testing.T) {
	payload, requirements, facilitatorAddr := buildValidExactSvmFixture(t)
	signer := &mockExactSvmSigner{
		addresses:     []solana.PublicKey{facilitatorAddr},
		sendSignature: solana.SignatureFromBytes(append([]byte{5}, make([]byte, 63)...)),
	}
	scheme := NewExactSvmScheme(signer)

	resp, err := scheme.Settle(context.Background(), payload, requirements, nil)
	require.NoError(t, err)
	assert.True(t, resp.Success)
}

// messageHashForPayload decodes the payload's transaction and derives the
// PendingSettlementStore key exactly as Settle does, so tests can assert on
// store state without duplicating scheme-internal decoding logic.
func messageHashForPayload(t *testing.T, payload types.PaymentPayload) string {
	t.Helper()
	solanaPayload, err := svm.PayloadFromMap(payload.Payload)
	require.NoError(t, err)
	tx, err := svm.DecodeTransaction(solanaPayload.Transaction)
	require.NoError(t, err)
	key, err := svm.MessageHash(tx)
	require.NoError(t, err)
	return key
}
