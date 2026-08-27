/**
 * Named error reason constants for the auth-capture EVM scheme.
 *
 * Every scheme-defined reason is namespaced `invalid_auth_capture_evm_*`.
 * Standard x402 reasons this binding also returns (e.g. `invalid_network`)
 * keep their canonical names.
 */

// Verify errors: pre-simulation
export const ErrInvalidPayloadFormat = "invalid_auth_capture_evm_payload_format";
export const ErrInvalidPayloadType = "invalid_auth_capture_evm_payload_type";
export const ErrVoidAuthorizerSignature = "invalid_auth_capture_evm_void_authorizer_signature";
export const ErrVoidRemainderFullCapture = "invalid_auth_capture_evm_void_remainder_full_capture";
export const ErrUnsupportedPaymentFlow = "invalid_auth_capture_evm_unsupported_payment_flow";
export const ErrUnsupportedScheme = "invalid_auth_capture_evm_scheme";
export const ErrNetworkMismatch = "invalid_auth_capture_evm_network_mismatch";
export const ErrInvalidNetwork = "invalid_network";
export const ErrInvalidAuthCaptureExtra = "invalid_auth_capture_evm_extra";
export const ErrMissingReceiverAuthorizer = "invalid_auth_capture_evm_missing_receiver_authorizer";
export const ErrUnsupportedOperatorType = "invalid_auth_capture_evm_unsupported_operator_type";
export const ErrInvalidPolicy = "invalid_auth_capture_evm_policy";
export const ErrLifecycleNotRelayed = "invalid_auth_capture_evm_lifecycle_not_relayed";
export const ErrOperatorTypeMismatch = "invalid_auth_capture_evm_operator_type_mismatch";
export const ErrOperatorNotAdmitted = "invalid_auth_capture_evm_operator_not_admitted";
export const ErrOperatorMismatch = "invalid_auth_capture_evm_operator_mismatch";
export const ErrSaltBindingMismatch = "invalid_auth_capture_evm_salt_binding_mismatch";
export const ErrAuthorizerSignature = "invalid_auth_capture_evm_authorizer_signature";
export const ErrUnauthenticatedLifecycleRequest =
  "invalid_auth_capture_evm_unauthenticated_lifecycle_request";
export const ErrUnexpectedPaymentState = "invalid_auth_capture_evm_unexpected_payment_state";
export const ErrRefundFundingUnavailable = "invalid_auth_capture_evm_refund_funding_unavailable";
export const ErrUnsupportedAssetTransferMethod =
  "invalid_auth_capture_evm_unsupported_asset_transfer_method";
export const ErrPayloadMethodMismatch = "invalid_auth_capture_evm_payload_method_mismatch";
export const ErrCaptureDeadlineExpired = "invalid_auth_capture_evm_capture_deadline_expired";
export const ErrRefundDeadlineExpired = "invalid_auth_capture_evm_refund_deadline_expired";
export const ErrInvalidDeadlineOrdering = "invalid_auth_capture_evm_deadline_ordering";
export const ErrAuthorizationExpired = "invalid_auth_capture_evm_authorization_expired";
export const ErrAuthorizationNotYetValid = "invalid_auth_capture_evm_authorization_not_yet_valid";
export const ErrTokenCollectorMismatch = "invalid_auth_capture_evm_token_collector_mismatch";
export const ErrTokenMismatch = "invalid_auth_capture_evm_token_mismatch";
export const ErrInvalidAuthCaptureSignature = "invalid_auth_capture_evm_signature";
export const ErrErc6492FactoryNotAllowed = "invalid_auth_capture_evm_erc6492_factory_not_allowed";
export const ErrAmountMismatch = "invalid_auth_capture_evm_amount_mismatch";
export const ErrNonceMismatch = "invalid_auth_capture_evm_nonce_mismatch";
export const ErrInsufficientBalance = "invalid_auth_capture_evm_insufficient_balance";
export const ErrSimulationFailed = "invalid_auth_capture_evm_simulation_failed";

// Typed simulation reverts
export const ErrPaymentAlreadyCollected = "invalid_auth_capture_evm_payment_already_collected";
export const ErrTokenCollectionFailed = "invalid_auth_capture_evm_token_collection_failed";
export const ErrInvalidCollector = "invalid_auth_capture_evm_collector";
export const ErrAmountOverflow = "invalid_auth_capture_evm_amount_overflow";
export const ErrInvalidFeeBps = "invalid_auth_capture_evm_fee_bps";
export const ErrInvalidFeeBpsRange = "invalid_auth_capture_evm_fee_bps_range";
export const ErrFeeBpsOutOfRange = "invalid_auth_capture_evm_fee_bps_out_of_range";
export const ErrZeroFeeReceiver = "invalid_auth_capture_evm_zero_fee_receiver";
export const ErrInvalidFeeReceiver = "invalid_auth_capture_evm_fee_receiver";
export const ErrInsufficientAuthorization = "invalid_auth_capture_evm_insufficient_authorization";
export const ErrZeroAuthorization = "invalid_auth_capture_evm_zero_authorization";
export const ErrRefundExceedsCapture = "invalid_auth_capture_evm_refund_exceeds_capture";

// Settle errors
export const ErrVerificationFailed = "invalid_auth_capture_evm_verification_failed";
export const ErrTransactionReverted = "invalid_auth_capture_evm_transaction_reverted";
export const ErrSettlementPending = "settlement_pending";

/**
 * Map an AuthCaptureEscrow custom-error name (decoded by viem from a
 * ContractFunctionRevertedError) to a stable invalidReason string. Anything
 * unmapped falls through to ErrSimulationFailed so verify() never leaks raw
 * selectors to callers.
 */
export const ESCROW_ERROR_TO_INVALID_REASON: Record<string, string> = {
  AfterPreApprovalExpiry: ErrAuthorizationExpired,
  InvalidExpiries: ErrInvalidDeadlineOrdering,
  ExceedsMaxAmount: ErrAmountMismatch,
  PaymentAlreadyCollected: ErrPaymentAlreadyCollected,
  TokenCollectionFailed: ErrTokenCollectionFailed,
  InvalidCollectorForOperation: ErrInvalidCollector,
  InvalidSender: ErrOperatorMismatch,
  ZeroAmount: ErrAmountMismatch,
  AmountOverflow: ErrAmountOverflow,
  FeeBpsOverflow: ErrInvalidFeeBps,
  InvalidFeeBpsRange: ErrInvalidFeeBpsRange,
  FeeBpsOutOfRange: ErrFeeBpsOutOfRange,
  FeeAmountOutOfRange: ErrFeeBpsOutOfRange,
  ZeroFeeReceiver: ErrZeroFeeReceiver,
  InvalidFeeReceiver: ErrInvalidFeeReceiver,
  AfterAuthorizationExpiry: ErrCaptureDeadlineExpired,
  InsufficientAuthorization: ErrInsufficientAuthorization,
  ZeroAuthorization: ErrZeroAuthorization,
  AfterRefundExpiry: ErrRefundDeadlineExpired,
  RefundExceedsCapture: ErrRefundExceedsCapture,
};
