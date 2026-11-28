import type { TransactionV1BudgetViolation } from "../../transactionV1";

/**
 * Named error reason constants for the auth-capture SVM facilitator.
 *
 * Scheme-specific TypeScript codes use `invalid_auth_capture_svm`.
 */

// Verify errors
export const ErrUnsupportedScheme = "invalid_auth_capture_svm_unsupported_scheme";
export const ErrNetworkMismatch = "invalid_auth_capture_svm_network_mismatch";
export const ErrMissingDelegate = "invalid_auth_capture_svm_payload_missing_delegate";
export const ErrMissingFeePayer = "invalid_auth_capture_svm_payload_missing_fee_payer";
export const ErrDelegateNotManaged = "invalid_auth_capture_svm_delegate_not_managed_by_facilitator";
export const ErrFeePayerNotManaged = "invalid_auth_capture_svm_fee_payer_not_managed_by_facilitator";
export const ErrInvalidPayloadTransaction = "invalid_auth_capture_svm_payload_transaction";
export const ErrTransactionCouldNotBeDecoded =
  "invalid_auth_capture_svm_payload_transaction_could_not_be_decoded";
export const ErrUnsupportedTransactionVersion = "unsupported_transaction_version";
export const ErrSignatureInvalid = "invalid_auth_capture_svm_payload_signature_invalid";
export const ErrExcessiveSigners = "invalid_auth_capture_svm_payload_excessive_signers";
export const ErrTransactionInstructionsLength =
  "invalid_auth_capture_svm_payload_transaction_instructions_length";
export const ErrComputeLimitInstructionTooHigh =
  "invalid_auth_capture_svm_payload_transaction_instructions_compute_limit_instruction_too_high";
export const ErrUnknownFourthInstruction = "invalid_auth_capture_svm_payload_unknown_fourth_instruction";
export const ErrUnknownFifthInstruction = "invalid_auth_capture_svm_payload_unknown_fifth_instruction";
export const ErrUnknownSixthInstruction = "invalid_auth_capture_svm_payload_unknown_sixth_instruction";
export const ErrUnknownSeventhInstruction = "invalid_auth_capture_svm_payload_unknown_seventh_instruction";
export const ErrUnknownOptionalInstruction =
  "invalid_auth_capture_svm_payload_unknown_optional_instruction";
export const ErrComputeLimitInstruction =
  "invalid_auth_capture_svm_payload_transaction_instructions_compute_limit_instruction";
export const ErrComputePriceInstruction =
  "invalid_auth_capture_svm_payload_transaction_instructions_compute_price_instruction";
export const ErrComputePriceInstructionTooHigh =
  "invalid_auth_capture_svm_payload_transaction_instructions_compute_price_instruction_too_high";
export const ErrTransactionSizeExceeded = "invalid_auth_capture_svm_payload_transaction_size_exceeded";
export const ErrTransactionV1ComputeBudgetInstruction =
  "invalid_auth_capture_svm_payload_transaction_v1_compute_budget_instruction";
export const ErrTransactionV1HeapSize = "invalid_auth_capture_svm_payload_transaction_v1_heap_size";

export const TRANSACTION_V1_BUDGET_REASONS: Record<TransactionV1BudgetViolation, string> = {
  priority_fee_bits: ErrComputePriceInstruction,
  heap_size: ErrTransactionV1HeapSize,
  compute_budget_instruction: ErrTransactionV1ComputeBudgetInstruction,
  compute_unit_limit_missing: ErrComputeLimitInstruction,
  compute_unit_limit_too_high: ErrComputeLimitInstructionTooHigh,
  loaded_accounts_data_size_limit_missing: "invalid_auth_capture_svm_payload_transaction_loaded_accounts_data_size_limit_missing",
  priority_fee_too_high: ErrComputePriceInstructionTooHigh,
};

export const ErrNoApproveInstruction = "invalid_auth_capture_svm_payload_no_approve_instruction";
export const ErrFeePayerTransferringFunds =
  "invalid_auth_capture_svm_payload_transaction_fee_payer_transferring_funds";
export const ErrMintMismatch = "invalid_auth_capture_svm_payload_mint_mismatch";
export const ErrApproveAuthorityMismatch = "invalid_auth_capture_svm_payload_approve_authority_mismatch";
export const ErrDelegateMismatch = "invalid_auth_capture_svm_payload_delegate_mismatch";
export const ErrAmountMismatch = "invalid_auth_capture_svm_payload_amount_mismatch";
export const ErrInvalidFeePayer = "invalid_auth_capture_svm_invalid_fee_payer";
export const ErrTransactionSigningFailed = "invalid_auth_capture_svm_transaction_signing_failed";
export const ErrTransactionSimulationFailed = "invalid_auth_capture_svm_transaction_simulation_failed";
export const ErrApproveSourceMismatch = "invalid_auth_capture_svm_approve_source_mismatch";

// Memo verification errors
export const ErrMemoMismatch = "invalid_auth_capture_svm_payload_memo_mismatch";
export const ErrMemoCount = "invalid_auth_capture_svm_payload_memo_count";

// Settle errors
export const ErrVerificationFailed = "invalid_auth_capture_svm_verification_failed";
export const ErrFeePayerMismatch = "invalid_auth_capture_svm_fee_payer_mismatch";
export const ErrTransactionFailed = "invalid_auth_capture_svm_transaction_failed";
export const ErrDuplicateSettlement = "duplicate_settlement";
export const ErrPostSettlementTransferNotConfirmed = "post_settlement_transfer_not_confirmed";
export const ErrVoidRequiresRevokeTransaction = "invalid_auth_capture_svm_void_requires_revoke_transaction";

// Smart wallet verification errors
export const ErrSmartWalletFeePayerNotIsolated =
  "invalid_auth_capture_svm_smart_wallet_fee_payer_not_isolated";
export const ErrSmartWalletMalformedComputeBudget =
  "invalid_auth_capture_svm_smart_wallet_malformed_compute_budget";
export const ErrSmartWalletMalformedComputeLimit =
  "invalid_auth_capture_svm_smart_wallet_malformed_compute_limit";
export const ErrSmartWalletMalformedComputePrice =
  "invalid_auth_capture_svm_smart_wallet_malformed_compute_price";
export const ErrSmartWalletComputeUnitsTooHigh =
  "invalid_auth_capture_svm_smart_wallet_compute_units_too_high";
export const ErrSmartWalletPriorityFeeTooHigh =
  "invalid_auth_capture_svm_smart_wallet_priority_fee_too_high";
export const ErrSmartWalletUnsupportedComputeBudget =
  "invalid_auth_capture_svm_smart_wallet_unsupported_compute_budget_instruction";
export const ErrSmartWalletAltResolutionUnavailable =
  "invalid_auth_capture_svm_smart_wallet_alt_resolution_not_available";
export const ErrSmartWalletAltResolutionFailed =
  "invalid_auth_capture_svm_smart_wallet_alt_resolution_failed";
export const ErrSmartWalletVerificationUnavailable =
  "invalid_auth_capture_svm_smart_wallet_verification_not_available";
export const ErrSmartWalletComputeBudgetViolation =
  "invalid_auth_capture_svm_smart_wallet_compute_budget_violation";
export const ErrSmartWalletSimulationFailed = "invalid_auth_capture_svm_smart_wallet_simulation_failed";
export const ErrSmartWalletCannotDeriveATA =
  "invalid_auth_capture_svm_smart_wallet_cannot_derive_destination_ata";
export const ErrSmartWalletNoTransferInSimulation =
  "invalid_auth_capture_svm_smart_wallet_no_transfer_in_simulation";
export const ErrSmartWalletTransferMismatch = "invalid_auth_capture_svm_smart_wallet_transfer_mismatch";
export const ErrSmartWalletMultipleMatchingTransfers =
  "invalid_auth_capture_svm_smart_wallet_multiple_matching_transfers";
export const ErrSmartWalletProgramNotAllowed = "invalid_auth_capture_svm_smart_wallet_program_not_allowed";

// Non-terminal settle error
export const ErrSettlementPending = "settlement_pending";
