/**
 * Named error reason constants for the upto EVM facilitator.
 *
 * Shared Permit2 errors are re-exported from exact/facilitator/errors.ts.
 * Upto-specific errors are defined here.
 *
 * These strings must be character-for-character identical to the Go constants
 * to maintain cross-SDK parity.
 */

// Re-export shared Permit2 errors
export {
  ErrPermit2InvalidSpender,
  ErrPermit2RecipientMismatch,
  ErrPermit2DeadlineExpired,
  ErrPermit2NotYetValid,
  ErrPermit2AmountMismatch,
  ErrPermit2TokenMismatch,
  ErrPermit2InvalidSignature,
  ErrPermit2AllowanceRequired,
  ErrPermit2InvalidAmount,
  ErrPermit2InvalidDestination,
  ErrPermit2InvalidOwner,
  ErrPermit2PaymentTooEarly,
  ErrPermit2InvalidNonce,
  ErrPermit2612AmountMismatch,
  ErrErc20ApprovalInvalidFormat,
  ErrErc20ApprovalFromMismatch,
  ErrErc20ApprovalAssetMismatch,
  ErrErc20ApprovalSpenderNotPermit2,
  ErrErc20ApprovalTxWrongTarget,
  ErrErc20ApprovalTxWrongSelector,
  ErrErc20ApprovalTxWrongSpender,
  ErrErc20ApprovalTxInvalidCalldata,
  ErrErc20ApprovalTxSignerMismatch,
  ErrErc20ApprovalTxInvalidSignature,
  ErrErc20ApprovalTxParseFailed,
} from "../../exact/facilitator/errors";

// Upto-specific errors
export const ErrUptoInvalidScheme = "invalid_upto_evm_scheme";
export const ErrUptoNetworkMismatch = "invalid_upto_evm_network_mismatch";
export const ErrUptoSettlementExceedsAmount = "invalid_upto_evm_payload_settlement_exceeds_amount";
export const ErrUptoAmountExceedsPermitted = "upto_amount_exceeds_permitted";
export const ErrUptoUnauthorizedFacilitator = "upto_unauthorized_facilitator";
export const ErrUptoFacilitatorMismatch = "upto_facilitator_mismatch";
