package svm

import (
	"context"
	"errors"
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
)

const testTerminalReason = "transaction_failed"

var testNetwork = x402.Network(SolanaDevnetCAIP2)

func TestRecordPendingOrTerminal_WaitFailureIsPending(t *testing.T) {
	store := x402.NewInMemoryPendingSettlementStore()
	err := RecordPendingOrTerminal(context.Background(), store, "key", "sig", "payer", testNetwork, testTerminalReason, errors.New("rpc: confirmation timeout"))

	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, x402.ErrSettlementPending, se.ErrorReason)
	assert.Equal(t, "sig", se.Transaction)

	stored, ok, getErr := store.Get(context.Background(), "key")
	require.NoError(t, getErr)
	require.True(t, ok)
	assert.Equal(t, "sig", stored)
}

func TestRecordPendingOrTerminal_ConfirmedOnChainFailureIsTerminal(t *testing.T) {
	store := x402.NewInMemoryPendingSettlementStore()
	require.NoError(t, store.Set(context.Background(), "key", "sig"))

	onChain := &TransactionFailedError{Signature: "sig", Err: map[string]any{"InstructionError": []any{2, map[string]any{"Custom": 4}}}}
	err := RecordPendingOrTerminal(context.Background(), store, "key", "sig", "payer", testNetwork, testTerminalReason, fmt.Errorf("confirm: %w", onChain))

	var se *x402.SettleError
	require.True(t, errors.As(err, &se))
	assert.Equal(t, testTerminalReason, se.ErrorReason)
	assert.Equal(t, "sig", se.Transaction)
	assert.Contains(t, err.Error(), "transaction failed on-chain")

	_, ok, getErr := store.Get(context.Background(), "key")
	require.NoError(t, getErr)
	assert.False(t, ok, "a terminal failure leaves nothing to reconcile")

	// A nil store still distinguishes the two outcomes.
	require.True(t, errors.As(RecordPendingOrTerminal(context.Background(), nil, "key", "sig", "payer", testNetwork, testTerminalReason, onChain), &se))
	assert.Equal(t, testTerminalReason, se.ErrorReason)
	require.True(t, errors.As(RecordPendingOrTerminal(context.Background(), nil, "key", "sig", "payer", testNetwork, testTerminalReason, errors.New("timeout")), &se))
	assert.Equal(t, x402.ErrSettlementPending, se.ErrorReason)
}

func TestIsTransactionFailed(t *testing.T) {
	failed := &TransactionFailedError{Signature: "sig", Err: "InstructionError"}
	assert.Equal(t, "transaction failed on-chain: InstructionError", failed.Error())
	assert.True(t, IsTransactionFailed(failed))
	assert.True(t, IsTransactionFailed(fmt.Errorf("wrapped: %w", failed)))
	assert.False(t, IsTransactionFailed(errors.New("rpc: confirmation timeout")))
	assert.False(t, IsTransactionFailed(nil))
}
