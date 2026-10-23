"""Stable SVM batch-settlement failure reasons."""


class BatchError(ValueError):
    """A rejected batch payment, with a machine-readable reason."""

    PAYLOAD_TYPE = "invalid_batch_settlement_svm_payload_type"
    PAYMENT_FLOW = "invalid_batch_settlement_svm_payment_flow"
    TOKEN_PROGRAM = "invalid_batch_settlement_svm_token_program"
    VOUCHER_SIGNATURE = "invalid_batch_settlement_svm_voucher_signature"
    CHANNEL_ID_MISMATCH = "invalid_batch_settlement_svm_channel_id_mismatch"
    FEE_PAYER_MISMATCH = "invalid_batch_settlement_svm_fee_payer_mismatch"
    RECEIVER_AUTHORIZER_MISMATCH = "invalid_batch_settlement_svm_receiver_authorizer_mismatch"
    RECEIVER_BINDING_UNAVAILABLE = "invalid_batch_settlement_svm_receiver_binding_unavailable"
    DELEGATED_UNAUTHENTICATED = "invalid_batch_settlement_svm_delegated_unauthenticated"
    CLOSE_AUTHORIZATION = "invalid_batch_settlement_svm_close_authorization"
    CLOSE_AMOUNT_UNSUPPORTED = "invalid_batch_settlement_svm_close_amount_unsupported"
    CLOSE_STATE = "invalid_batch_settlement_svm_close_state"
    CHANNEL_CLOSING = "invalid_batch_settlement_svm_channel_closing"
    WITHDRAW_DELAY_MISMATCH = "invalid_batch_settlement_svm_withdraw_delay_mismatch"
    WITHDRAW_DELAY_OUT_OF_RANGE = "invalid_batch_settlement_svm_withdraw_delay_out_of_range"
    CUMULATIVE_AMOUNT_MISMATCH = "invalid_batch_settlement_svm_cumulative_amount_mismatch"
    CUMULATIVE_EXCEEDS_DEPOSIT = "invalid_batch_settlement_svm_cumulative_exceeds_deposit"
    VOUCHER_EXPIRY = "invalid_batch_settlement_svm_voucher_expiry"
    SETUP_TRANSACTION = "invalid_batch_settlement_svm_setup_transaction"
    SETTLEMENT_SIMULATION = "invalid_batch_settlement_svm_settlement_simulation"
    DEPOSIT_BELOW_MIN_DEPOSIT = "invalid_batch_settlement_svm_deposit_below_min_deposit"
    CHANNEL_STATE = "invalid_batch_settlement_svm_channel_state"
    REFUND_TRANSACTION = "invalid_batch_settlement_svm_refund_transaction"
    PAYOUT_ATTRIBUTION_AMBIGUOUS = "invalid_batch_settlement_svm_payout_attribution_ambiguous"

    CHANNEL_BUSY = "duplicate_settlement"
    OPERATION_CEILING_CHANGED = "invalid_batch_settlement_svm_operation_ceiling_changed"

    def __init__(self, reason: str, message: str | None = None):
        super().__init__(message or reason)
        self.reason = reason
