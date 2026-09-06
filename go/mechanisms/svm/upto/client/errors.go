package client

// Client error constants for the SVM `upto` payment-channel scheme
const (
	ErrUnsupportedNetwork         = "invalid_upto_svm_client_unsupported_network"
	ErrInvalidPaymentRequirements = "invalid_upto_svm_client_invalid_payment_requirements"
	ErrInvalidAssetAddress        = "invalid_upto_svm_client_invalid_asset_address"
	ErrInvalidPayToAddress        = "invalid_upto_svm_client_invalid_payto_address"
	ErrInvalidFeePayerAddress     = "invalid_upto_svm_client_invalid_fee_payer_address"
	ErrInvalidReceiverAuthorizer  = "invalid_upto_svm_client_invalid_receiver_authorizer"
	ErrFailedToGetMintAccount     = "invalid_upto_svm_client_failed_to_get_mint_account"
	ErrUnknownTokenProgram        = "invalid_upto_svm_client_unknown_token_program"
	ErrFailedToDecodeMintData     = "invalid_upto_svm_client_failed_to_decode_mint_data"
	ErrInvalidAmount              = "invalid_upto_svm_client_invalid_amount"
	ErrFailedToGetLatestBlockhash = "invalid_upto_svm_client_failed_to_get_latest_blockhash"
	ErrFailedToGetSlot            = "invalid_upto_svm_client_failed_to_get_slot"
	ErrFailedToBuildOpen          = "invalid_upto_svm_client_failed_to_build_open_transaction"
	ErrFailedToSignTransaction    = "invalid_upto_svm_client_failed_to_sign_transaction"
	ErrFailedToEncodeTransaction  = "invalid_upto_svm_client_failed_to_encode_transaction"
)
