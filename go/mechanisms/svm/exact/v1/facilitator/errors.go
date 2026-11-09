package facilitator

// Facilitator error constants for the exact SVM (Solana) scheme (V1)
const (
	// Verify errors
	ErrUnsupportedScheme            = "invalid_exact_solana_unsupported_scheme"
	ErrNetworkMismatch              = "invalid_exact_solana_network_mismatch"
	ErrInvalidExtraField            = "invalid_exact_solana_extra_field"
	ErrMissingFeePayer              = "invalid_exact_solana_payload_missing_fee_payer"
	ErrFeePayerNotManaged           = "invalid_exact_solana_fee_payer_not_managed_by_facilitator"
	ErrInvalidPayloadTransaction    = "invalid_exact_solana_payload_transaction"
	ErrTransactionCouldNotBeDecoded = "invalid_exact_solana_payload_transaction_could_not_be_decoded"
	// ErrUnsupportedTransactionVersion mirrors svm.ErrUnsupportedTransactionVersion.
	ErrUnsupportedTransactionVersion  = "unsupported_transaction_version"
	ErrTransactionSizeExceeded        = "invalid_exact_solana_payload_transaction_size_exceeded"
	ErrSignatureInvalid               = "invalid_exact_solana_payload_signature_invalid"
	ErrTransactionInstructionsLength  = "invalid_exact_solana_payload_transaction_instructions_length"
	ErrUnknownFourthInstruction       = "invalid_exact_solana_payload_unknown_fourth_instruction"
	ErrUnknownFifthInstruction        = "invalid_exact_solana_payload_unknown_fifth_instruction"
	ErrUnknownSixthInstruction        = "invalid_exact_solana_payload_unknown_sixth_instruction"
	ErrComputeLimitInstruction        = "invalid_exact_solana_payload_transaction_instructions_compute_limit_instruction"
	ErrComputePriceInstruction        = "invalid_exact_solana_payload_transaction_instructions_compute_price_instruction"
	ErrComputePriceInstructionTooHigh = "invalid_exact_solana_payload_transaction_instructions_compute_price_instruction_too_high"
	// Version-1 (SIMD-0385) message config errors; see the v2 exact facilitator.
	ErrComputeLimitInstructionTooHigh     = "invalid_exact_solana_payload_transaction_instructions_compute_limit_instruction_too_high"
	ErrLoadedAccountsDataSizeLimitMissing = "invalid_exact_solana_payload_transaction_loaded_accounts_data_size_limit_missing"
	ErrTransactionV1ComputeBudgetIx       = "invalid_exact_solana_payload_transaction_v1_compute_budget_instruction"
	ErrTransactionV1HeapSize              = "invalid_exact_solana_payload_transaction_v1_heap_size"
	ErrNoTransferInstruction              = "invalid_exact_solana_payload_no_transfer_instruction"
	ErrFeePayerTransferringFunds          = "invalid_exact_solana_payload_transaction_fee_payer_transferring_funds"
	ErrMintMismatch                       = "invalid_exact_solana_payload_mint_mismatch"
	ErrRecipientMismatch                  = "invalid_exact_solana_payload_recipient_mismatch"
	ErrAmountMismatch                     = "invalid_exact_solana_payload_amount_mismatch"
	ErrInvalidFeePayer                    = "invalid_exact_solana_invalid_fee_payer"
	ErrTransactionSigningFailed           = "invalid_exact_solana_transaction_signing_failed"
	ErrTransactionSimulationFailed        = "invalid_exact_solana_transaction_simulation_failed"

	// Memo verification errors
	ErrMemoMismatch = "invalid_exact_solana_payload_memo_mismatch"
	ErrMemoCount    = "invalid_exact_solana_payload_memo_count"

	// Settle errors
	ErrVerificationFailed            = "invalid_exact_solana_verification_failed"
	ErrFeePayerMismatch              = "invalid_exact_solana_fee_payer_mismatch"
	ErrTransactionFailed             = "invalid_exact_solana_transaction_failed"
	ErrTransactionConfirmationFailed = "invalid_exact_solana_transaction_confirmation_failed"
	ErrDuplicateSettlement           = "duplicate_settlement"
)
