package svm

import (
	"context"
	"fmt"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// RecordPendingOrTerminal persists sigStr under key in store so a subsequent
// settle attempt for the same payload can reconcile against it instead of
// re-broadcasting, then returns the settlement_pending error carrying
// waitErr's message.
//
// If the store write itself fails, a later retry has no record to reconcile
// against — returning settlement_pending regardless would let it blindly
// re-verify/re-broadcast and risk a double-send. In that case this instead
// returns a terminal error (terminalReason), preserving sigStr for manual
// reconciliation. store may be nil, which disables the write and always
// returns settlement_pending (mirrors every other PendingSettlementStore
// call site, where a nil store means the bookkeeping is simply skipped).
//
// A waitErr that is or wraps *TransactionFailedError is terminal: the chain
// confirmed the transaction with an execution error, so nothing is left to
// reconcile. It returns terminalReason with sigStr preserved and removes any
// pending record under key.
func RecordPendingOrTerminal(
	ctx context.Context,
	store x402.PendingSettlementStore,
	key string,
	sigStr string,
	payer string,
	network x402.Network,
	terminalReason string,
	waitErr error,
) error {
	if IsTransactionFailed(waitErr) {
		if store != nil {
			_ = store.Delete(ctx, key)
		}
		return x402.NewSettleError(terminalReason, payer, network, sigStr, waitErr.Error())
	}
	if store != nil {
		if setErr := store.Set(ctx, key, sigStr); setErr != nil {
			return x402.NewSettleError(terminalReason, payer, network, sigStr,
				fmt.Sprintf("settlement_pending, but failed to persist for retry: %s", setErr.Error()))
		}
	}
	return x402.NewSettleError(x402.ErrSettlementPending, payer, network, sigStr, waitErr.Error())
}
