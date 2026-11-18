package client

// Client error constants for the exact SVM (Solana) scheme (V2)
const (
	ErrUnsupportedNetwork           = "invalid_exact_solana_client_unsupported_network"
	ErrInvalidAssetAddress          = "invalid_exact_solana_client_invalid_asset_address"
	ErrFailedToGetMintAccount       = "invalid_exact_solana_client_failed_to_get_mint_account"
	ErrUnknownTokenProgram          = "invalid_exact_solana_client_unknown_token_program"
	ErrInvalidPayToAddress          = "invalid_exact_solana_client_invalid_payto_address"
	ErrFailedToDeriveSourceATA      = "invalid_exact_solana_client_failed_to_derive_source_ata"
	ErrFailedToDeriveDestinationATA = "invalid_exact_solana_client_failed_to_derive_destination_ata"
	ErrInvalidAmount                = "invalid_exact_solana_client_invalid_amount"
	ErrFeePayerRequired             = "invalid_exact_solana_client_fee_payer_required"
	ErrInvalidFeePayerAddress       = "invalid_exact_solana_client_invalid_fee_payer_address"
	ErrFailedToDecodeMintData       = "invalid_exact_solana_client_failed_to_decode_mint_data"
	ErrFailedToGetLatestBlockhash   = "invalid_exact_solana_client_failed_to_get_latest_blockhash"
	ErrFailedToBuildComputeLimitIx  = "invalid_exact_solana_client_failed_to_build_compute_limit_instruction"
	ErrFailedToBuildComputePriceIx  = "invalid_exact_solana_client_failed_to_build_compute_price_instruction"
	ErrFailedToBuildTransferIx      = "invalid_exact_solana_client_failed_to_build_transfer_instruction"
	ErrFailedToBuildMemoIx          = "invalid_exact_solana_client_failed_to_build_memo_instruction"
	ErrFailedToCreateTransaction    = "invalid_exact_solana_client_failed_to_create_transaction"
	ErrFailedToSignTransaction      = "invalid_exact_solana_client_failed_to_sign_transaction"
	ErrFailedToEncodeTransaction    = "invalid_exact_solana_client_failed_to_encode_transaction"
	ErrMemoExceedsMaxSize           = "invalid_exact_solana_client_memo_exceeds_max_size"
)
