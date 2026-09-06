/**
 * Named error reason constants for the exact SVM facilitator.
 *
 * These strings must be character-for-character identical to the Go
 * constants in go/mechanisms/svm/exact/facilitator/errors.go to maintain
 * cross-SDK parity.
 */

// Verify errors
export const ErrUnsupportedScheme = "invalid_exact_svm_unsupported_scheme";
export const ErrNetworkMismatch = "invalid_exact_svm_network_mismatch";
export const ErrMissingFeePayer = "invalid_exact_svm_payload_missing_fee_payer";
export const ErrFeePayerNotManaged = "invalid_exact_svm_fee_payer_not_managed_by_facilitator";
export const ErrInvalidPayloadTransaction = "invalid_exact_svm_payload_transaction";
export const ErrTransactionCouldNotBeDecoded =
  "invalid_exact_svm_payload_transaction_could_not_be_decoded";
export const ErrSignatureInvalid = "invalid_exact_svm_payload_signature_invalid";
export const ErrExcessiveSigners = "invalid_exact_svm_payload_excessive_signers";
export const ErrTransactionInstructionsLength =
  "invalid_exact_svm_payload_transaction_instructions_length";
export const ErrComputeLimitInstructionTooHigh =
  "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction_too_high";
export const ErrUnknownFourthInstruction = "invalid_exact_svm_payload_unknown_fourth_instruction";
export const ErrUnknownFifthInstruction = "invalid_exact_svm_payload_unknown_fifth_instruction";
export const ErrUnknownSixthInstruction = "invalid_exact_svm_payload_unknown_sixth_instruction";
export const ErrUnknownSeventhInstruction = "invalid_exact_svm_payload_unknown_seventh_instruction";
export const ErrUnknownOptionalInstruction =
  "invalid_exact_svm_payload_unknown_optional_instruction";
export const ErrComputeLimitInstruction =
  "invalid_exact_svm_payload_transaction_instructions_compute_limit_instruction";
export const ErrComputePriceInstruction =
  "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction";
export const ErrComputePriceInstructionTooHigh =
  "invalid_exact_svm_payload_transaction_instructions_compute_price_instruction_too_high";
export const ErrNoTransferInstruction = "invalid_exact_svm_payload_no_transfer_instruction";
export const ErrFeePayerTransferringFunds =
  "invalid_exact_svm_payload_transaction_fee_payer_transferring_funds";
export const ErrMintMismatch = "invalid_exact_svm_payload_mint_mismatch";
export const ErrRecipientMismatch = "invalid_exact_svm_payload_recipient_mismatch";
export const ErrAmountMismatch = "invalid_exact_svm_payload_amount_mismatch";
export const ErrInvalidFeePayer = "invalid_exact_svm_invalid_fee_payer";
export const ErrTransactionSigningFailed = "invalid_exact_svm_transaction_signing_failed";
export const ErrTransactionSimulationFailed = "invalid_exact_svm_transaction_simulation_failed";

// Memo verification errors
export const ErrMemoMismatch = "invalid_exact_svm_payload_memo_mismatch";
export const ErrMemoCount = "invalid_exact_svm_payload_memo_count";

// Settle errors
export const ErrVerificationFailed = "invalid_exact_svm_verification_failed";
export const ErrFeePayerMismatch = "invalid_exact_svm_fee_payer_mismatch";
export const ErrTransactionFailed = "invalid_exact_svm_transaction_failed";
export const ErrDuplicateSettlement = "duplicate_settlement";
export const ErrPostSettlementTransferNotConfirmed = "post_settlement_transfer_not_confirmed";

// Smart wallet verification errors
export const ErrSmartWalletFeePayerNotIsolated =
  "invalid_exact_svm_smart_wallet_fee_payer_not_isolated";
export const ErrSmartWalletMalformedComputeBudget =
  "invalid_exact_svm_smart_wallet_malformed_compute_budget";
export const ErrSmartWalletMalformedComputeLimit =
  "invalid_exact_svm_smart_wallet_malformed_compute_limit";
export const ErrSmartWalletMalformedComputePrice =
  "invalid_exact_svm_smart_wallet_malformed_compute_price";
export const ErrSmartWalletComputeUnitsTooHigh =
  "invalid_exact_svm_smart_wallet_compute_units_too_high";
export const ErrSmartWalletPriorityFeeTooHigh =
  "invalid_exact_svm_smart_wallet_priority_fee_too_high";
export const ErrSmartWalletUnsupportedComputeBudget =
  "invalid_exact_svm_smart_wallet_unsupported_compute_budget_instruction";
export const ErrSmartWalletAltResolutionUnavailable =
  "invalid_exact_svm_smart_wallet_alt_resolution_not_available";
export const ErrSmartWalletAltResolutionFailed =
  "invalid_exact_svm_smart_wallet_alt_resolution_failed";
export const ErrSmartWalletVerificationUnavailable =
  "invalid_exact_svm_smart_wallet_verification_not_available";
export const ErrSmartWalletComputeBudgetViolation =
  "invalid_exact_svm_smart_wallet_compute_budget_violation";
export const ErrSmartWalletSimulationFailed = "invalid_exact_svm_smart_wallet_simulation_failed";
export const ErrSmartWalletCannotDeriveATA =
  "invalid_exact_svm_smart_wallet_cannot_derive_destination_ata";
export const ErrSmartWalletNoTransferInSimulation =
  "invalid_exact_svm_smart_wallet_no_transfer_in_simulation";
export const ErrSmartWalletTransferMismatch = "invalid_exact_svm_smart_wallet_transfer_mismatch";
export const ErrSmartWalletMultipleMatchingTransfers =
  "invalid_exact_svm_smart_wallet_multiple_matching_transfers";
export const ErrSmartWalletProgramNotAllowed = "invalid_exact_svm_smart_wallet_program_not_allowed";

/**
 * Non-terminal settle error reason used when a transaction was broadcast but
 * `confirmTransaction` couldn't observe its confirmation in time. Always
 * carries the broadcast signature (as `SettleResponse.transaction`) so a
 * caller can reconcile onchain, and mirrors `x402.ErrSettlementPending` /
 * `evm.ErrSettlementPending` so `x402ResourceServer`'s generic
 * single-retry-on-settlement_pending logic recognizes it uniformly across
 * schemes/networks. Replaces the former `transaction_failed`/
 * `settlement_confirmation_timeout`-style reasons on the confirm-timeout
 * path, which were terminal and gave callers no reconciliation path.
 */
export const ErrSettlementPending = "settlement_pending";
