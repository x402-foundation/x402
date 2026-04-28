package facilitator

// Facilitator error constants for the commerce EVM scheme
const (
	// Verify errors
	ErrInvalidScheme             = "invalid_commerce_evm_scheme"
	ErrNetworkMismatch           = "invalid_commerce_evm_network_mismatch"
	ErrInvalidPayload            = "invalid_commerce_evm_payload"
	ErrMissingSignature          = "invalid_commerce_evm_payload_missing_signature"
	ErrFailedToGetNetworkConfig  = "invalid_commerce_evm_failed_to_get_network_config"
	ErrMissingEip712Domain       = "invalid_commerce_evm_missing_eip712_domain"
	ErrRecipientMismatch         = "invalid_commerce_evm_recipient_mismatch"
	ErrInvalidAuthorizationValue = "invalid_commerce_evm_authorization_value"
	ErrInvalidRequiredAmount     = "invalid_commerce_evm_required_amount"
	ErrAmountMismatch            = "invalid_commerce_evm_amount_mismatch"
	ErrInvalidSignatureFormat    = "invalid_commerce_evm_signature_format"
	ErrFailedToVerifySignature   = "invalid_commerce_evm_failed_to_verify_signature"
	ErrInvalidSignature          = "invalid_commerce_evm_signature"
	ErrValidBeforeExpired        = "invalid_commerce_evm_payload_authorization_valid_before"
	ErrValidAfterInFuture        = "invalid_commerce_evm_payload_authorization_valid_after"
	ErrMissingExtraFields        = "invalid_commerce_evm_missing_extra_fields"
	ErrTokenMismatch             = "invalid_commerce_evm_token_mismatch"
	ErrReceiverMismatch          = "invalid_commerce_evm_receiver_mismatch"
	ErrInvalidNetworkFormat      = "invalid_commerce_evm_invalid_network_format"

	// Settle errors
	ErrVerificationFailed      = "invalid_commerce_evm_verification_failed"
	ErrFailedToParseSignature  = "invalid_commerce_evm_failed_to_parse_signature"
	ErrFailedToExecuteSettle   = "invalid_commerce_evm_failed_to_execute_settle"
	ErrFailedToGetReceipt      = "invalid_commerce_evm_failed_to_get_receipt"
	ErrTransactionFailed       = "invalid_commerce_evm_transaction_failed"
	ErrUnsupportedSettleMethod = "invalid_commerce_evm_unsupported_settlement_method"
)
