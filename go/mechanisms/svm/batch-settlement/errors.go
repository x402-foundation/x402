package batchsettlement

const errorPrefix = "invalid_batch_settlement_svm_"

// Machine-readable batch-settlement failure reasons.
const (
	ErrPayloadType                = errorPrefix + "payload_type"
	ErrPaymentFlow                = errorPrefix + "payment_flow"
	ErrTokenProgram               = errorPrefix + "token_program"
	ErrVoucherSignature           = errorPrefix + "voucher_signature"
	ErrChannelIDMismatch          = errorPrefix + "channel_id_mismatch"
	ErrFeePayerMismatch           = errorPrefix + "fee_payer_mismatch"
	ErrReceiverAuthorizerMismatch = errorPrefix + "receiver_authorizer_mismatch"
	ErrReceiverBindingUnavailable = errorPrefix + "receiver_binding_unavailable"
	ErrDelegatedUnauthenticated   = errorPrefix + "delegated_unauthenticated"
	ErrCloseAuthorization         = errorPrefix + "close_authorization"
	ErrCloseAmountUnsupported     = errorPrefix + "close_amount_unsupported"
	ErrCloseState                 = errorPrefix + "close_state"
	ErrChannelClosing             = errorPrefix + "channel_closing"
	ErrWithdrawDelayMismatch      = errorPrefix + "withdraw_delay_mismatch"
	ErrWithdrawDelayOutOfRange    = errorPrefix + "withdraw_delay_out_of_range"
	ErrCumulativeAmountMismatch   = errorPrefix + "cumulative_amount_mismatch"
	ErrCumulativeExceedsDeposit   = errorPrefix + "cumulative_exceeds_deposit"
	ErrVoucherExpiry              = errorPrefix + "voucher_expiry"
	ErrSetupTransaction           = errorPrefix + "setup_transaction"
	ErrSettlementSimulation       = errorPrefix + "settlement_simulation"
	ErrDepositBelowMinDeposit     = errorPrefix + "deposit_below_min_deposit"
	ErrChannelState               = errorPrefix + "channel_state"
	ErrRefundTransaction          = errorPrefix + "refund_transaction"
	ErrPayoutAttributionAmbiguous = errorPrefix + "payout_attribution_ambiguous"
	ErrOperationCeilingChanged    = errorPrefix + "operation_ceiling_changed"
)

// ErrorReasons is every batch-settlement machine reason, in declaration order.
func ErrorReasons() []string {
	return []string{
		ErrPayloadType,
		ErrPaymentFlow,
		ErrTokenProgram,
		ErrVoucherSignature,
		ErrChannelIDMismatch,
		ErrFeePayerMismatch,
		ErrReceiverAuthorizerMismatch,
		ErrReceiverBindingUnavailable,
		ErrDelegatedUnauthenticated,
		ErrCloseAuthorization,
		ErrCloseAmountUnsupported,
		ErrCloseState,
		ErrChannelClosing,
		ErrWithdrawDelayMismatch,
		ErrWithdrawDelayOutOfRange,
		ErrCumulativeAmountMismatch,
		ErrCumulativeExceedsDeposit,
		ErrVoucherExpiry,
		ErrSetupTransaction,
		ErrSettlementSimulation,
		ErrDepositBelowMinDeposit,
		ErrChannelState,
		ErrRefundTransaction,
		ErrPayoutAttributionAmbiguous,
		ErrOperationCeilingChanged,
	}
}
