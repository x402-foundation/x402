/** Error codes for the batch-settlement EVM scheme (see scheme_batch_settlement_evm2.md). */

export const ErrChannelNotFound = "invalid_batch_settlement_evm_channel_not_found";
export const ErrTokenMismatch = "invalid_batch_settlement_evm_token_mismatch";
export const ErrInvalidVoucherSignature = "invalid_batch_settlement_evm_voucher_signature";
export const ErrCumulativeExceedsBalance =
  "invalid_batch_settlement_evm_cumulative_exceeds_balance";
export const ErrCumulativeAmountBelowClaimed =
  "invalid_batch_settlement_evm_cumulative_below_claimed";
export const ErrInsufficientBalance = "invalid_batch_settlement_evm_insufficient_balance";
export const ErrDepositTransactionFailed =
  "invalid_batch_settlement_evm_deposit_transaction_failed";
export const ErrClaimTransactionFailed = "invalid_batch_settlement_evm_claim_transaction_failed";
export const ErrSettleTransactionFailed = "invalid_batch_settlement_evm_settle_transaction_failed";
export const ErrInvalidScheme = "invalid_batch_settlement_evm_scheme";
export const ErrNetworkMismatch = "invalid_batch_settlement_evm_network_mismatch";
export const ErrMissingEip712Domain = "invalid_batch_settlement_evm_missing_eip712_domain";
export const ErrValidBeforeExpired =
  "invalid_batch_settlement_evm_payload_authorization_valid_before";
export const ErrValidAfterInFuture =
  "invalid_batch_settlement_evm_payload_authorization_valid_after";
export const ErrInvalidReceiveAuthorizationSignature =
  "invalid_batch_settlement_evm_receive_authorization_signature";
export const ErrErc3009AuthorizationRequired =
  "invalid_batch_settlement_evm_erc3009_authorization_required";
export const ErrRefundTransactionFailed = "invalid_batch_settlement_evm_refund_transaction_failed";
export const ErrInvalidPayloadType = "invalid_batch_settlement_evm_payload_type";
export const ErrWithdrawDelayOutOfRange =
  "invalid_batch_settlement_evm_withdraw_delay_out_of_range";
export const ErrChannelIdMismatch = "invalid_batch_settlement_evm_channel_id_mismatch";
export const ErrReceiverMismatch = "invalid_batch_settlement_evm_receiver_mismatch";
export const ErrReceiverAuthorizerMismatch =
  "invalid_batch_settlement_evm_receiver_authorizer_mismatch";
export const ErrWithdrawDelayMismatch = "invalid_batch_settlement_evm_withdraw_delay_mismatch";
export const ErrAuthorizerAddressMismatch =
  "invalid_batch_settlement_evm_authorizer_address_mismatch";
export const ErrDepositSimulationFailed = "invalid_batch_settlement_evm_deposit_simulation_failed";
export const ErrClaimSimulationFailed = "invalid_batch_settlement_evm_claim_simulation_failed";
export const ErrSettleSimulationFailed = "invalid_batch_settlement_evm_settle_simulation_failed";
export const ErrRefundPayload = "invalid_batch_settlement_evm_refund_payload";
export const ErrRefundSimulationFailed = "invalid_batch_settlement_evm_refund_simulation_failed";
export const ErrRpcReadFailed = "invalid_batch_settlement_evm_rpc_read_failed";
export const ErrPermit2AuthorizationRequired =
  "invalid_batch_settlement_evm_permit2_authorization_required";
export const ErrPermit2InvalidSpender = "invalid_batch_settlement_evm_permit2_invalid_spender";
export const ErrPermit2AmountMismatch = "invalid_batch_settlement_evm_permit2_amount_mismatch";
export const ErrPermit2DeadlineExpired = "invalid_batch_settlement_evm_permit2_deadline_expired";
export const ErrPermit2InvalidSignature = "invalid_batch_settlement_evm_permit2_invalid_signature";
export const ErrPermit2AllowanceRequired =
  "invalid_batch_settlement_evm_permit2_allowance_required";
export const ErrEip2612AmountMismatch = "invalid_batch_settlement_evm_eip2612_amount_mismatch";
export const ErrEip2612OwnerMismatch = "invalid_batch_settlement_evm_eip2612_owner_mismatch";
export const ErrEip2612AssetMismatch = "invalid_batch_settlement_evm_eip2612_asset_mismatch";
export const ErrEip2612SpenderMismatch = "invalid_batch_settlement_evm_eip2612_spender_mismatch";
export const ErrEip2612DeadlineExpired = "invalid_batch_settlement_evm_eip2612_deadline_expired";
export const ErrErc20ApprovalUnavailable =
  "invalid_batch_settlement_evm_erc20_approval_unavailable";

/** Resource server: 402 `error` and lifecycle `reason` (same strings as the spec). */
export const ErrCumulativeAmountMismatch =
  "invalid_batch_settlement_evm_cumulative_amount_mismatch";
export const ErrChannelBusy = "invalid_batch_settlement_evm_channel_busy";
export const ErrChargeExceedsSignedCumulative =
  "invalid_batch_settlement_evm_charge_exceeds_signed_cumulative";
export const ErrMissingChannel = "invalid_batch_settlement_evm_missing_channel";
export const ErrRefundNoBalance = "invalid_batch_settlement_evm_refund_no_balance";
export const ErrRefundAmountInvalid = "invalid_batch_settlement_evm_refund_amount_invalid";
