package facilitator

const (
	// Payload parsing errors
	ErrInvalidPayload        = "batch_settlement_evm_invalid_payload_type"
	ErrInvalidDepositPayload = "batch_settlement_evm_invalid_deposit_payload"
	ErrInvalidVoucherPayload = "batch_settlement_evm_invalid_voucher_payload"
	ErrInvalidClaimPayload   = "batch_settlement_evm_invalid_claim_payload"
	ErrInvalidSettlePayload  = "batch_settlement_evm_invalid_settle_payload"
	ErrInvalidRefundPayload  = "batch_settlement_evm_invalid_refund_payload"
	ErrInvalidScheme         = "batch_settlement_evm_invalid_scheme"
	ErrNetworkMismatch       = "batch_settlement_evm_network_mismatch"

	// Channel config validation errors
	ErrReceiverMismatch           = "batch_settlement_evm_receiver_mismatch"
	ErrReceiverAuthorizerMismatch = "batch_settlement_evm_receiver_authorizer_mismatch"
	ErrTokenMismatch              = "batch_settlement_evm_token_mismatch"
	ErrWithdrawDelayOutOfRange    = "batch_settlement_evm_withdraw_delay_out_of_range"
	ErrWithdrawDelayMismatch      = "batch_settlement_evm_withdraw_delay_mismatch"
	ErrChannelIdMismatch          = "batch_settlement_evm_channel_id_mismatch"

	// ERC-3009 authorization errors
	ErrValidBeforeExpired           = "batch_settlement_evm_payload_authorization_valid_before"
	ErrValidAfterInFuture           = "batch_settlement_evm_payload_authorization_valid_after"
	ErrErc3009SignatureInvalid      = "batch_settlement_evm_invalid_receive_authorization_signature"
	ErrErc3009AuthorizationRequired = "batch_settlement_evm_erc3009_authorization_required"
	ErrMissingEip712Domain          = "batch_settlement_evm_missing_eip712_domain"

	// Voucher errors
	ErrVoucherSignatureInvalid = "batch_settlement_evm_invalid_voucher_signature"
	ErrMaxClaimableTooLow      = "batch_settlement_evm_cumulative_below_claimed"
	ErrMaxClaimableExceedsBal  = "batch_settlement_evm_cumulative_exceeds_balance"
	ErrInsufficientBalance     = "batch_settlement_evm_insufficient_balance"
	ErrDepositVoucherMismatch  = "batch_settlement_evm_deposit_voucher_mismatch"

	// Channel state errors
	ErrChannelStateReadFailed = "batch_settlement_evm_channel_state_read_failed"
	ErrChannelNotFound        = "batch_settlement_evm_channel_not_found"
	ErrWithdrawalPending      = "batch_settlement_evm_withdrawal_pending"

	// Transaction errors
	ErrDepositTransactionFailed = "batch_settlement_evm_deposit_transaction_failed"
	ErrClaimTransactionFailed   = "batch_settlement_evm_claim_transaction_failed"
	ErrSettleTransactionFailed  = "batch_settlement_evm_settle_transaction_failed"
	ErrRefundTransactionFailed  = "batch_settlement_evm_refund_transaction_failed"
	ErrTransactionReverted      = "batch_settlement_evm_transaction_reverted"
	ErrWaitForReceipt           = "batch_settlement_evm_wait_for_receipt_failed"

	// Simulation errors
	ErrDepositSimulationFailed = "batch_settlement_evm_deposit_simulation_failed"
	ErrClaimSimulationFailed   = "batch_settlement_evm_claim_simulation_failed"
	ErrSettleSimulationFailed  = "batch_settlement_evm_settle_simulation_failed"
	ErrRefundSimulationFailed  = "batch_settlement_evm_refund_simulation_failed"

	// Authorizer errors
	ErrAuthorizerAddressMismatch = "batch_settlement_evm_authorizer_address_mismatch"

	// Settle action errors
	ErrUnknownSettleAction = "batch_settlement_evm_unknown_settle_action"
)
