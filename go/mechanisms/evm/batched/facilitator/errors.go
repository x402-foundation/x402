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

	// Channel state errors
	ErrChannelStateReadFailed = "batch_settlement_evm_channel_state_read_failed"
	ErrChannelNotFound        = "batch_settlement_evm_channel_not_found"
	ErrRpcReadFailed          = "batch_settlement_evm_rpc_read_failed"

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

	// Permit2 deposit authorization errors. Mirrors TS
	// `typescript/.../facilitator/errors.ts`.
	ErrPermit2AuthorizationRequired = "batch_settlement_evm_permit2_authorization_required"
	ErrPermit2InvalidSpender        = "batch_settlement_evm_permit2_invalid_spender"
	ErrPermit2AmountMismatch        = "batch_settlement_evm_permit2_amount_mismatch"
	ErrPermit2DeadlineExpired       = "batch_settlement_evm_permit2_deadline_expired"
	ErrPermit2InvalidSignature      = "batch_settlement_evm_permit2_invalid_signature"
	ErrPermit2AllowanceRequired     = "batch_settlement_evm_permit2_allowance_required"

	// EIP-2612 permit segment errors (gas-sponsored Permit2 branch).
	ErrEip2612AmountMismatch  = "batch_settlement_evm_eip2612_amount_mismatch"
	ErrEip2612OwnerMismatch   = "batch_settlement_evm_eip2612_owner_mismatch"
	ErrEip2612AssetMismatch   = "batch_settlement_evm_eip2612_asset_mismatch"
	ErrEip2612SpenderMismatch = "batch_settlement_evm_eip2612_spender_mismatch"
	ErrEip2612DeadlineExpired = "batch_settlement_evm_eip2612_deadline_expired"
	ErrEip2612InvalidFormat   = "batch_settlement_evm_eip2612_invalid_format"
	ErrEip2612InvalidSignature = "batch_settlement_evm_eip2612_invalid_signature"

	// ERC-20 approval gas-sponsoring errors. The facilitator extension signer
	// broadcasts a pre-signed `approve(Permit2, max)` then the deposit() tx;
	// these errors surface format/payer/asset mismatches and missing signers.
	ErrErc20ApprovalUnavailable    = "batch_settlement_evm_erc20_approval_unavailable"
	ErrErc20ApprovalInvalidFormat  = "batch_settlement_evm_erc20_approval_invalid_format"
	ErrErc20ApprovalFromMismatch   = "batch_settlement_evm_erc20_approval_from_mismatch"
	ErrErc20ApprovalAssetMismatch  = "batch_settlement_evm_erc20_approval_asset_mismatch"
	ErrErc20ApprovalWrongSpender   = "batch_settlement_evm_erc20_approval_wrong_spender"
	ErrErc20ApprovalBroadcastFailed = "batch_settlement_evm_erc20_approval_broadcast_failed"
)
