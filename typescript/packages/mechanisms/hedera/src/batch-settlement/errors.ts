/** Error codes for the batch-settlement Hedera scheme (see scheme_batch_settlement_hedera.md). */

export const ErrChannelNotFound = "invalid_batch_settlement_hedera_channel_not_found";
export const ErrTokenMismatch = "invalid_batch_settlement_hedera_token_mismatch";
export const ErrInvalidVoucherSignature = "invalid_batch_settlement_hedera_voucher_signature";
export const ErrCumulativeExceedsBalance =
  "invalid_batch_settlement_hedera_cumulative_exceeds_balance";
export const ErrCumulativeAmountBelowClaimed =
  "invalid_batch_settlement_hedera_cumulative_below_claimed";
export const ErrInsufficientBalance = "invalid_batch_settlement_hedera_insufficient_balance";
export const ErrDepositTransactionFailed =
  "invalid_batch_settlement_hedera_deposit_transaction_failed";
export const ErrClaimTransactionFailed = "invalid_batch_settlement_hedera_claim_transaction_failed";
export const ErrSettleTransactionFailed =
  "invalid_batch_settlement_hedera_settle_transaction_failed";
export const ErrInvalidScheme = "invalid_batch_settlement_hedera_scheme";
export const ErrNetworkMismatch = "invalid_batch_settlement_hedera_network_mismatch";
export const ErrRefundTransactionFailed =
  "invalid_batch_settlement_hedera_refund_transaction_failed";
export const ErrInvalidPayloadType = "invalid_batch_settlement_hedera_payload_type";
export const ErrWithdrawDelayOutOfRange =
  "invalid_batch_settlement_hedera_withdraw_delay_out_of_range";
export const ErrChannelIdMismatch = "invalid_batch_settlement_hedera_channel_id_mismatch";
export const ErrInvalidChannelId = "invalid_batch_settlement_hedera_channel_id_invalid";
export const ErrReceiverMismatch = "invalid_batch_settlement_hedera_receiver_mismatch";
export const ErrReceiverAuthorizerMismatch =
  "invalid_batch_settlement_hedera_receiver_authorizer_mismatch";
export const ErrWithdrawDelayMismatch = "invalid_batch_settlement_hedera_withdraw_delay_mismatch";
export const ErrAuthorizerAddressMismatch =
  "invalid_batch_settlement_hedera_authorizer_address_mismatch";
export const ErrAuthorizerNotConfigured =
  "invalid_batch_settlement_hedera_authorizer_not_configured";
export const ErrDepositSimulationFailed =
  "invalid_batch_settlement_hedera_deposit_simulation_failed";
export const ErrDepositBelowMinDeposit =
  "invalid_batch_settlement_hedera_deposit_below_min_deposit";
export const ErrClaimSimulationFailed = "invalid_batch_settlement_hedera_claim_simulation_failed";
export const ErrSettleSimulationFailed = "invalid_batch_settlement_hedera_settle_simulation_failed";
export const ErrNothingToSettle = "invalid_batch_settlement_hedera_nothing_to_settle";
export const ErrRefundPayload = "invalid_batch_settlement_hedera_refund_payload";
export const ErrRefundSimulationFailed = "invalid_batch_settlement_hedera_refund_simulation_failed";
export const ErrRpcReadFailed = "invalid_batch_settlement_hedera_rpc_read_failed";

// Hedera-specific: HTS allowance deposit authorization + account preconditions.
export const ErrAllowanceAuthorizationRequired =
  "invalid_batch_settlement_hedera_allowance_authorization_required";
export const ErrAllowanceSignatureInvalid =
  "invalid_batch_settlement_hedera_allowance_signature_invalid";
export const ErrAllowanceDeadlineExpired =
  "invalid_batch_settlement_hedera_allowance_deadline_expired";
export const ErrAllowanceNonceUsed = "invalid_batch_settlement_hedera_allowance_nonce_used";
export const ErrAllowanceInsufficient = "invalid_batch_settlement_hedera_allowance_insufficient";
export const ErrPayerAccountNotFound = "invalid_batch_settlement_hedera_payer_account_not_found";
export const ErrUnsupportedAccountKey = "invalid_batch_settlement_hedera_unsupported_account_key";
export const ErrTokenNotAssociated = "invalid_batch_settlement_hedera_token_not_associated";
export const ErrAmountExceedsInt64 = "invalid_batch_settlement_hedera_amount_exceeds_int64";
export const ErrUnsupportedAssetTransferMethod =
  "invalid_batch_settlement_hedera_unsupported_asset_transfer_method";

/** Resource server: 402 `error` and lifecycle `reason` (same strings as the spec). */
export const ErrCumulativeAmountMismatch =
  "invalid_batch_settlement_hedera_cumulative_amount_mismatch";
export const ErrChannelBusy = "invalid_batch_settlement_hedera_channel_busy";
export const ErrVerificationStateUnavailable =
  "invalid_batch_settlement_hedera_verification_state_unavailable";
export const ErrChargeExceedsSignedCumulative =
  "invalid_batch_settlement_hedera_charge_exceeds_signed_cumulative";
export const ErrMissingChannel = "invalid_batch_settlement_hedera_missing_channel";
export const ErrRefundNoBalance = "invalid_batch_settlement_hedera_refund_no_balance";
export const ErrRefundAmountInvalid = "invalid_batch_settlement_hedera_refund_amount_invalid";

/** Protocol-level, non-terminal: broadcast succeeded but confirmation could not be established. */
export const ErrSettlementPending = "settlement_pending";
/** Terminal fallback when a settle attempt fails before or without a usable transaction. */
export const ErrInvalidTransactionState = "invalid_transaction_state";
