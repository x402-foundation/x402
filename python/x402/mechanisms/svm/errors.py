"""SVM execution errors shared by signers and facilitators."""


class TransactionOnchainFailureError(RuntimeError):
    """A confirmed or finalized transaction failed during on-chain execution."""
