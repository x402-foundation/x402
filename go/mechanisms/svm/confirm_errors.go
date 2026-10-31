package svm

import (
	"errors"
	"fmt"
)

// TransactionFailedError is returned by a FacilitatorSvmSigner's
// ConfirmTransaction when the chain confirmed the transaction with an
// execution error (getSignatureStatuses: confirmed/finalized, status.Err set).
// It is terminal, unlike a timeout or RPC failure, which stay
// settlement_pending. Err is status.Err as the RPC returned it.
type TransactionFailedError struct {
	Signature string
	Err       any
}

func (e *TransactionFailedError) Error() string {
	if e.Err == nil {
		return "transaction failed on-chain"
	}
	return fmt.Sprintf("transaction failed on-chain: %v", e.Err)
}

// IsTransactionFailed reports whether err is or wraps a *TransactionFailedError.
func IsTransactionFailed(err error) bool {
	var failed *TransactionFailedError
	return errors.As(err, &failed)
}
