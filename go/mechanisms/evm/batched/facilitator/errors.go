package facilitator

const (
	// Payload parsing errors
	ErrInvalidPayload           = "invalid_batched_payload"
	ErrInvalidDepositPayload    = "invalid_batched_deposit_payload"
	ErrInvalidVoucherPayload    = "invalid_batched_voucher_payload"
	ErrInvalidClaimPayload      = "invalid_batched_claim_payload"
	ErrInvalidSettlePayload     = "invalid_batched_settle_payload"
	ErrInvalidRefundPayload     = "invalid_batched_refund_payload"

	// Channel config validation errors
	ErrReceiverMismatch         = "batched_receiver_mismatch"
	ErrTokenMismatch            = "batched_token_mismatch"
	ErrWithdrawDelayTooShort    = "batched_withdraw_delay_too_short"
	ErrWithdrawDelayTooLong     = "batched_withdraw_delay_too_long"
	ErrChannelIdMismatch        = "batched_channel_id_mismatch"

	// ERC-3009 authorization errors
	ErrValidBeforeExpired       = "batched_erc3009_valid_before_expired"
	ErrValidAfterInFuture       = "batched_erc3009_valid_after_in_future"
	ErrErc3009SignatureInvalid  = "batched_erc3009_signature_invalid"

	// Voucher errors
	ErrVoucherSignatureInvalid  = "batched_voucher_signature_invalid"
	ErrMaxClaimableTooLow       = "batched_max_claimable_too_low"
	ErrMaxClaimableExceedsBal   = "batched_max_claimable_exceeds_balance"
	ErrInsufficientBalance      = "batched_insufficient_payer_balance"

	// Channel state errors
	ErrChannelStateReadFailed   = "batched_channel_state_read_failed"
	ErrChannelNotFound          = "batched_channel_not_found"

	// Transaction errors
	ErrTransactionFailed        = "batched_transaction_failed"
	ErrTransactionReverted      = "batched_transaction_reverted"
	ErrWaitForReceipt           = "batched_wait_for_receipt_failed"

	// Settle action errors
	ErrUnknownSettleAction      = "batched_unknown_settle_action"
)
