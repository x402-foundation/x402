/**
 * AVM Facilitator error codes for verify and settle responses.
 *
 * Uses snake_case `invalid_exact_avm_*` prefix convention,
 * consistent with EVM (`invalid_exact_evm_*`) and SVM patterns.
 */

// Verify errors — scheme/network/version
export const ErrInvalidScheme = "invalid_exact_avm_scheme";
export const ErrNetworkMismatch = "invalid_exact_avm_network_mismatch";
export const ErrInvalidVersion = "invalid_exact_avm_invalid_version";

// Verify errors — payload structure
export const ErrInvalidPayload = "invalid_exact_avm_payload";
export const ErrGroupSizeExceeded = "invalid_exact_avm_group_size_exceeded";
export const ErrInvalidPaymentIndex = "invalid_exact_avm_payment_index";
export const ErrInvalidTransaction = "invalid_exact_avm_invalid_transaction";
export const ErrInvalidGroupId = "invalid_exact_avm_invalid_group_id";

// Verify errors — payment correctness
export const ErrNotAssetTransfer = "invalid_exact_avm_not_asset_transfer";
export const ErrAmountMismatch = "invalid_exact_avm_amount_mismatch";
export const ErrReceiverMismatch = "invalid_exact_avm_receiver_mismatch";
export const ErrAssetMismatch = "invalid_exact_avm_asset_mismatch";

// Verify errors — fee payer
export const ErrInvalidFeePayer = "invalid_exact_avm_invalid_fee_payer";
export const ErrFeeTooHigh = "invalid_exact_avm_fee_too_high";

// Verify errors — signature
export const ErrPaymentNotSigned = "invalid_exact_avm_payment_not_signed";
export const ErrInvalidSignature = "invalid_exact_avm_invalid_signature";

// Verify errors — simulation
export const ErrSimulationFailed = "invalid_exact_avm_simulation_failed";

// Verify errors — facilitator safety
export const ErrFacilitatorTransferring = "invalid_exact_avm_facilitator_transferring";

// Security errors
export const ErrUnsignedNonFacilitator = "invalid_exact_avm_unsigned_non_facilitator";

// Settle errors
export const ErrSettleFailed = "invalid_exact_avm_settlement_failed";
export const ErrConfirmationFailed = "invalid_exact_avm_confirmation_failed";
