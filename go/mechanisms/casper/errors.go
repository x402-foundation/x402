package casper

import "errors"

// ErrNonCanonicalSignature identifies a secp256k1 signature with a high-s scalar.
var ErrNonCanonicalSignature = errors.New("secp256k1 signature must use low-s")

// TransactionExecutionError reports an included transaction whose execution failed.
// The outcome is terminal; waiting again cannot change it.
type TransactionExecutionError struct {
	Message string
}

func (e *TransactionExecutionError) Error() string {
	return "transaction execution failed: " + e.Message
}
