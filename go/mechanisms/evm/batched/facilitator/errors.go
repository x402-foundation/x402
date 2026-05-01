// Package facilitator emits canonical batch-settlement EVM rejection tokens.
//
// Wire form: every facilitator-emitted reason starts with `invalid_batch_settlement_evm_`,
// mirroring the `invalid_exact_evm_*` shape used by the exact EVM facilitator
// (see go/mechanisms/evm/exact/facilitator/errors.go) and matching CDP Accounts API
// `x402VerifyInvalidReason` / `x402SettleErrorReason` enums one-for-one.
//
// Naming discipline:
//   - Exported symbols stay `Err…` (Go-idiomatic) — only the string values are
//     part of the wire contract.
//   - Internal `_invalid_` collapses into the leading `invalid_` envelope so
//     `batch_settlement_evm_invalid_scheme` becomes `invalid_batch_settlement_evm_scheme`,
//     not `invalid_batch_settlement_evm_invalid_scheme`.
//
// Breaking change notice: prior to this revision these values were prefixed
// `batch_settlement_evm_*`. Downstream substring-matching consumers
// (notably cdp-facilitator's `MapBatchSDKReasonToCDP`) need a coordinated
// switch to identity passthrough (or a deprecation shim) — see PR description.
package facilitator

import "github.com/x402-foundation/x402/go/mechanisms/evm/batched"

const (
	// Payload parsing errors
	ErrInvalidPayload        = "invalid_batch_settlement_evm_payload_type"
	ErrInvalidDepositPayload = "invalid_batch_settlement_evm_deposit_payload"
	ErrInvalidVoucherPayload = "invalid_batch_settlement_evm_voucher_payload"
	ErrInvalidClaimPayload   = "invalid_batch_settlement_evm_claim_payload"
	ErrInvalidSettlePayload  = "invalid_batch_settlement_evm_settle_payload"
	ErrInvalidRefundPayload  = "invalid_batch_settlement_evm_refund_payload"
	ErrInvalidScheme         = "invalid_batch_settlement_evm_scheme"
	ErrNetworkMismatch       = "invalid_batch_settlement_evm_network_mismatch"

	// Channel config validation errors
	ErrReceiverMismatch           = "invalid_batch_settlement_evm_receiver_mismatch"
	ErrReceiverAuthorizerMismatch = "invalid_batch_settlement_evm_receiver_authorizer_mismatch"
	ErrTokenMismatch              = "invalid_batch_settlement_evm_token_mismatch"
	ErrWithdrawDelayOutOfRange    = "invalid_batch_settlement_evm_withdraw_delay_out_of_range"
	ErrWithdrawDelayMismatch      = "invalid_batch_settlement_evm_withdraw_delay_mismatch"
	ErrChannelIdMismatch          = "invalid_batch_settlement_evm_channel_id_mismatch"

	// ERC-3009 authorization errors
	ErrValidBeforeExpired           = "invalid_batch_settlement_evm_payload_authorization_valid_before"
	ErrValidAfterInFuture           = "invalid_batch_settlement_evm_payload_authorization_valid_after"
	ErrErc3009SignatureInvalid      = "invalid_batch_settlement_evm_receive_authorization_signature"
	ErrErc3009AuthorizationRequired = "invalid_batch_settlement_evm_erc3009_authorization_required"
	ErrMissingEip712Domain          = "invalid_batch_settlement_evm_missing_eip712_domain"

	// Voucher errors
	ErrVoucherSignatureInvalid = "invalid_batch_settlement_evm_voucher_signature"
	// ErrMaxClaimableTooLow is aliased from batched.ErrCumulativeBelowClaimed
	// so the corrective-recovery client check (client/scheme.go) and the
	// facilitator emitter share a single source of truth and can never drift.
	ErrMaxClaimableTooLow     = batched.ErrCumulativeBelowClaimed
	ErrMaxClaimableExceedsBal = "invalid_batch_settlement_evm_cumulative_exceeds_balance"
	ErrInsufficientBalance    = "invalid_batch_settlement_evm_insufficient_balance"

	// Channel state errors
	ErrChannelStateReadFailed = "invalid_batch_settlement_evm_channel_state_read_failed"
	ErrChannelNotFound        = "invalid_batch_settlement_evm_channel_not_found"
	ErrRpcReadFailed          = "invalid_batch_settlement_evm_rpc_read_failed"

	// Transaction errors
	ErrDepositTransactionFailed = "invalid_batch_settlement_evm_deposit_transaction_failed"
	ErrClaimTransactionFailed   = "invalid_batch_settlement_evm_claim_transaction_failed"
	ErrSettleTransactionFailed  = "invalid_batch_settlement_evm_settle_transaction_failed"
	ErrRefundTransactionFailed  = "invalid_batch_settlement_evm_refund_transaction_failed"
	ErrTransactionReverted      = "invalid_batch_settlement_evm_transaction_reverted"
	ErrWaitForReceipt           = "invalid_batch_settlement_evm_wait_for_receipt_failed"

	// Simulation errors
	ErrDepositSimulationFailed = "invalid_batch_settlement_evm_deposit_simulation_failed"
	ErrClaimSimulationFailed   = "invalid_batch_settlement_evm_claim_simulation_failed"
	ErrSettleSimulationFailed  = "invalid_batch_settlement_evm_settle_simulation_failed"
	ErrRefundSimulationFailed  = "invalid_batch_settlement_evm_refund_simulation_failed"

	// Authorizer errors
	ErrAuthorizerAddressMismatch = "invalid_batch_settlement_evm_authorizer_address_mismatch"

	// Settle action errors
	ErrUnknownSettleAction = "invalid_batch_settlement_evm_unknown_settle_action"

	// Permit2 deposit authorization errors. Mirrors TS
	// `typescript/.../facilitator/errors.ts`.
	ErrPermit2AuthorizationRequired = "invalid_batch_settlement_evm_permit2_authorization_required"
	ErrPermit2InvalidSpender        = "invalid_batch_settlement_evm_permit2_spender"
	ErrPermit2AmountMismatch        = "invalid_batch_settlement_evm_permit2_amount_mismatch"
	ErrPermit2DeadlineExpired       = "invalid_batch_settlement_evm_permit2_deadline_expired"
	ErrPermit2InvalidSignature      = "invalid_batch_settlement_evm_permit2_signature"
	ErrPermit2AllowanceRequired     = "invalid_batch_settlement_evm_permit2_allowance_required"

	// EIP-2612 permit segment errors (gas-sponsored Permit2 branch).
	ErrEip2612AmountMismatch   = "invalid_batch_settlement_evm_eip2612_amount_mismatch"
	ErrEip2612OwnerMismatch    = "invalid_batch_settlement_evm_eip2612_owner_mismatch"
	ErrEip2612AssetMismatch    = "invalid_batch_settlement_evm_eip2612_asset_mismatch"
	ErrEip2612SpenderMismatch  = "invalid_batch_settlement_evm_eip2612_spender_mismatch"
	ErrEip2612DeadlineExpired  = "invalid_batch_settlement_evm_eip2612_deadline_expired"
	ErrEip2612InvalidFormat    = "invalid_batch_settlement_evm_eip2612_format"
	ErrEip2612InvalidSignature = "invalid_batch_settlement_evm_eip2612_signature"

	// ERC-20 approval gas-sponsoring errors. The facilitator extension signer
	// broadcasts a pre-signed `approve(Permit2, max)` then the deposit() tx;
	// these errors surface format/payer/asset mismatches and missing signers.
	ErrErc20ApprovalUnavailable     = "invalid_batch_settlement_evm_erc20_approval_unavailable"
	ErrErc20ApprovalInvalidFormat   = "invalid_batch_settlement_evm_erc20_approval_format"
	ErrErc20ApprovalFromMismatch    = "invalid_batch_settlement_evm_erc20_approval_from_mismatch"
	ErrErc20ApprovalAssetMismatch   = "invalid_batch_settlement_evm_erc20_approval_asset_mismatch"
	ErrErc20ApprovalWrongSpender    = "invalid_batch_settlement_evm_erc20_approval_wrong_spender"
	ErrErc20ApprovalBroadcastFailed = "invalid_batch_settlement_evm_erc20_approval_broadcast_failed"
)
