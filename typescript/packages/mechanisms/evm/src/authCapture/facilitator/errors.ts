/**
 * Named error reason constants for the authCapture EVM facilitator.
 *
 * Mirrors the upstream x402 mechanisms/evm pattern (see exact/upto/batch-settlement
 * facilitator/errors.ts). The string values are wire-level identifiers locked
 * by the merged authCapture-EVM spec (specs/schemes/authCapture/scheme_authCapture_evm.md,
 * "Error Codes" section) — do not rename them without a corresponding spec PR.
 */

// Verify errors — pre-simulation
export const ErrInvalidPayloadFormat = "invalid_payload_format";
export const ErrUnsupportedScheme = "unsupported_scheme";
export const ErrNetworkMismatch = "network_mismatch";
export const ErrInvalidNetwork = "invalid_network";
export const ErrInvalidAuthCaptureExtra = "invalid_authCapture_extra";
export const ErrUnsupportedAssetTransferMethod = "unsupported_asset_transfer_method";
export const ErrPayloadMethodMismatch = "payload_method_mismatch";
export const ErrCaptureDeadlineExpired = "capture_deadline_expired";
export const ErrInvalidDeadlineOrdering = "invalid_deadline_ordering";
export const ErrAuthorizationExpired = "authorization_expired";
export const ErrAuthorizationNotYetValid = "authorization_not_yet_valid";
export const ErrTokenCollectorMismatch = "token_collector_mismatch";
export const ErrTokenMismatch = "token_mismatch";
export const ErrInvalidAuthCaptureSignature = "invalid_authCapture_signature";
export const ErrAmountMismatch = "amount_mismatch";
export const ErrNonceMismatch = "nonce_mismatch";
export const ErrInsufficientBalance = "insufficient_balance";
export const ErrSimulationFailed = "simulation_failed";

// Typed simulation reverts — surfaced when the on-chain simulate call reverts
// with a known AuthCaptureEscrow custom error.
export const ErrPaymentAlreadyCollected = "payment_already_collected";
export const ErrTokenCollectionFailed = "token_collection_failed";
export const ErrInvalidCollector = "invalid_collector";
export const ErrInvalidCaptureAuthorizer = "invalid_capture_authorizer";
export const ErrAmountOverflow = "amount_overflow";
export const ErrInvalidFeeBps = "invalid_fee_bps";
export const ErrInvalidFeeBpsRange = "invalid_fee_bps_range";
export const ErrFeeBpsOutOfRange = "fee_bps_out_of_range";
export const ErrZeroFeeReceiver = "zero_fee_receiver";
export const ErrInvalidFeeReceiver = "invalid_fee_receiver";
export const ErrInsufficientAuthorization = "insufficient_authorization";
export const ErrZeroAuthorization = "zero_authorization";

// Settle errors
export const ErrVerificationFailed = "verification_failed";
export const ErrTransactionReverted = "transaction_reverted";

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
  InvalidSender: ErrInvalidCaptureAuthorizer,
  ZeroAmount: ErrAmountMismatch,
  AmountOverflow: ErrAmountOverflow,
  FeeBpsOverflow: ErrInvalidFeeBps,
  InvalidFeeBpsRange: ErrInvalidFeeBpsRange,
  FeeBpsOutOfRange: ErrFeeBpsOutOfRange,
  ZeroFeeReceiver: ErrZeroFeeReceiver,
  InvalidFeeReceiver: ErrInvalidFeeReceiver,
  AfterAuthorizationExpiry: ErrCaptureDeadlineExpired,
  InsufficientAuthorization: ErrInsufficientAuthorization,
  ZeroAuthorization: ErrZeroAuthorization,
};
