package facilitator

import (
	"context"
	"errors"
	"fmt"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// Exercises the PendingSettlementStore fast path wired into UptoSvmScheme's
// settleDeposit and settleClaim (see scheme.go): a settle attempt whose
// ConfirmTransaction wait fails must populate the store keyed by the
// deposit/settlement cache key; a subsequent settle for the identical
// channel must hit that entry, skip verify/broadcast entirely (via
// awaitPendingUptoSignature), and reconcile against the already-broadcast
// signature. Mirrors the TS/Python SVM upto pending-settlement test suites.
//
// depositCacheKey/settlementCacheKey mirror the key formats inlined in
// settleDeposit/settleClaim (scheme.go); duplicated here (rather than
// exported from production code purely for tests) since the format is an
// internal implementation detail, not part of the store's contract.

func depositCacheKey(network, channelID string) string {
	return fmt.Sprintf("upto:deposit:%s:%s", network, channelID)
}

func settlementCacheKey(network, channelID string) string {
	return fmt.Sprintf("upto:%s:%s", network, channelID)
}

func TestDepositSettle_PendingSettlementStore_CacheMissSuccessLeavesNoEntry(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	signer.onSend = func(*solana.Transaction) {
		stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	}

	response, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	require.NoError(t, err)
	assert.True(t, response.Success)

	key := depositCacheKey(fixture.requirements.Network, fixture.channelID.String())
	_, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	assert.False(t, ok, "a successful broadcast+confirm must never leave a pending entry")
}

func TestDepositSettle_PendingSettlementStore_TerminalFailureNeverTouchesStore(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	// An existing channel account makes the deposit a terminal
	// ErrChannelAlreadyOpen failure, never reaching broadcast.
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	assert.Equal(t, ErrChannelAlreadyOpen, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions())

	key := depositCacheKey(fixture.requirements.Network, fixture.channelID.String())
	_, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	assert.False(t, ok, "a terminal failure must never populate the pending-settlement store")
}

func TestDepositSettle_PendingSettlementStore_CacheMissConfirmFailurePopulatesStore(t *testing.T) {
	signer := newMockSigner(t, 1)
	signer.confirmErr = errors.New("rpc: confirmation timeout")
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrSettlementPending, se.ErrorReason)
	require.NotEmpty(t, se.Transaction, "the broadcast signature must be preserved on settlement_pending")

	key := depositCacheKey(fixture.requirements.Network, fixture.channelID.String())
	stored, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	require.True(t, ok, "confirm-wait failure must populate the pending-settlement store")
	assert.Equal(t, se.Transaction, stored)
}

func TestDepositSettle_PendingSettlementStore_CacheHitReconcilesWithoutRebroadcast(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	key := depositCacheKey(fixture.requirements.Network, fixture.channelID.String())
	priorSig := "3vZ9Q4mF1x1sVEnTkGqwKN1JcgmXCzXfDMz6WrPPBhKtNBbNaRiJ8CT9jkuoAJyGVUvHNNbCTUmzL6yEsSm4x9wp"
	require.NoError(t, scheme.pendingStore.Set(context.Background(), key, priorSig))

	response, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	require.NoError(t, err)
	assert.True(t, response.Success)
	assert.Equal(t, priorSig, response.Transaction)
	assert.Equal(t, "10000", response.Amount)
	assert.Empty(t, signer.sentTransactions(), "reconciliation must never re-broadcast the open")
	assert.Zero(t, stub.simulations(), "reconciliation skips re-simulation entirely")

	_, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	assert.False(t, ok, "successful reconciliation must clear the pending entry")
}

func TestDepositSettle_PendingSettlementStore_CacheHitStillPendingReturnsAgainWithoutRebroadcast(t *testing.T) {
	signer := newMockSigner(t, 1)
	signer.confirmErr = errors.New("still pending")
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	key := depositCacheKey(fixture.requirements.Network, fixture.channelID.String())
	priorSig := "3vZ9Q4mF1x1sVEnTkGqwKN1JcgmXCzXfDMz6WrPPBhKtNBbNaRiJ8CT9jkuoAJyGVUvHNNbCTUmzL6yEsSm4x9wp"
	require.NoError(t, scheme.pendingStore.Set(context.Background(), key, priorSig))

	_, err := scheme.Settle(context.Background(), fixture.payload, fixture.requirements, nil)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrSettlementPending, se.ErrorReason)
	assert.Equal(t, priorSig, se.Transaction)
	assert.Empty(t, signer.sentTransactions(), "reconciliation must never re-broadcast the open")

	stored, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	require.True(t, ok)
	assert.Equal(t, priorSig, stored)
}

func TestClaimSettle_PendingSettlementStore_CacheMissSuccessLeavesNoEntry(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	response, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	require.NoError(t, err)
	assert.True(t, response.Success)

	key := settlementCacheKey(fixture.requirements.Network, fixture.channelID.String())
	_, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	assert.False(t, ok, "a successful broadcast+confirm must never leave a pending entry")
}

func TestClaimSettle_PendingSettlementStore_TerminalFailureNeverTouchesStore(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	// 10001 exceeds the fixture's signed ceiling (deposit of 10000), so this
	// fails ErrSettlementExceedsAmount before ever dispatching to settleClaim.
	_, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 10001), fixture.claimRequirements(10001), nil,
	)
	assert.Equal(t, ErrSettlementExceedsAmount, settleErrorReason(t, err))
	assert.Empty(t, signer.sentTransactions())

	key := settlementCacheKey(fixture.requirements.Network, fixture.channelID.String())
	_, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	assert.False(t, ok, "a terminal failure must never populate the pending-settlement store")
}

func TestClaimSettle_PendingSettlementStore_CacheMissConfirmFailurePopulatesStore(t *testing.T) {
	signer := newMockSigner(t, 1)
	signer.confirmErr = errors.New("rpc: confirmation timeout")
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))

	_, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrSettlementPending, se.ErrorReason)
	require.NotEmpty(t, se.Transaction)

	key := settlementCacheKey(fixture.requirements.Network, fixture.channelID.String())
	stored, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	require.True(t, ok, "confirm-wait failure must populate the pending-settlement store")
	assert.Equal(t, se.Transaction, stored)
}

func TestClaimSettle_PendingSettlementStore_CacheHitReconcilesWithoutRebroadcast(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	key := settlementCacheKey(fixture.requirements.Network, fixture.channelID.String())
	priorSig := "3vZ9Q4mF1x1sVEnTkGqwKN1JcgmXCzXfDMz6WrPPBhKtNBbNaRiJ8CT9jkuoAJyGVUvHNNbCTUmzL6yEsSm4x9wp"
	require.NoError(t, scheme.pendingStore.Set(context.Background(), key, priorSig))

	response, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	require.NoError(t, err)
	assert.True(t, response.Success)
	assert.Equal(t, priorSig, response.Transaction)
	assert.Equal(t, "1858", response.Amount)
	assert.Empty(t, signer.sentTransactions(), "reconciliation must never re-submit settle_and_seal + distribute")

	_, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	assert.False(t, ok, "successful reconciliation must clear the pending entry")
}

func TestClaimSettle_PendingSettlementStore_CacheHitStillPendingReturnsAgainWithoutRebroadcast(t *testing.T) {
	signer := newMockSigner(t, 1)
	signer.confirmErr = errors.New("still pending")
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	key := settlementCacheKey(fixture.requirements.Network, fixture.channelID.String())
	priorSig := "3vZ9Q4mF1x1sVEnTkGqwKN1JcgmXCzXfDMz6WrPPBhKtNBbNaRiJ8CT9jkuoAJyGVUvHNNbCTUmzL6yEsSm4x9wp"
	require.NoError(t, scheme.pendingStore.Set(context.Background(), key, priorSig))

	_, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrSettlementPending, se.ErrorReason)
	assert.Equal(t, priorSig, se.Transaction)
	assert.Empty(t, signer.sentTransactions())

	stored, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	require.True(t, ok)
	assert.Equal(t, priorSig, stored)
}

// A malformed pending-store entry (e.g. corrupted by a non-conforming custom
// PendingSettlementStore implementation) must not permanently wedge the
// channel: awaitPendingUptoSignature drops it and surfaces a terminal error
// so a fresh settle attempt can proceed instead of retrying forever.
func TestClaimSettle_PendingSettlementStore_MalformedSignatureDropsEntry(t *testing.T) {
	signer := newMockSigner(t, 1)
	stub := newStubRPC(t)
	fixture := newPaymentFixture(t, signer)
	scheme := newScheme(signer, stub, nil)
	stub.setAccount(fixture.channelID.String(), fixture.openChannel().encode(t))
	key := settlementCacheKey(fixture.requirements.Network, fixture.channelID.String())
	require.NoError(t, scheme.pendingStore.Set(context.Background(), key, "not-valid-base58-!!!"))

	_, err := scheme.Settle(
		context.Background(), fixture.claimPayload(t, 1858), fixture.claimRequirements(1858), nil,
	)
	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, ErrChannelBroadcast, se.ErrorReason)

	_, ok, getErr := scheme.pendingStore.Get(context.Background(), key)
	require.NoError(t, getErr)
	assert.False(t, ok, "a malformed entry must be dropped, not retried forever")
}
