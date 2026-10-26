package casper

// TransactionExecutionError reports that a transaction was included in a block
// but its execution failed. It is terminal: unlike a confirmation timeout,
// waiting again cannot change the outcome.
type TransactionExecutionError struct {
	Message string
}

func (e *TransactionExecutionError) Error() string {
	return "transaction execution failed: " + e.Message
}
