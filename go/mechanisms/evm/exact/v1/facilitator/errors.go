package facilitator

// Facilitator error constants for the exact EVM scheme (V1)
const (
	// Verify errors
	ErrUnsupportedScheme               = "invalid_exact_evm_unsupported_scheme"
	ErrNetworkMismatch                 = "invalid_exact_evm_network_mismatch"
	ErrInvalidPayload                  = "invalid_exact_evm_payload"
	ErrMissingSignature                = "invalid_exact_evm_payload_missing_signature"
	ErrFailedToGetNetworkConfig        = "invalid_exact_evm_failed_to_get_network_config"
	ErrInvalidExtraField               = "invalid_exact_evm_extra_field"
	ErrMissingEip712Domain             = "invalid_exact_evm_missing_eip712_domain"
	ErrRecipientMismatch               = "invalid_exact_evm_payload_recipient_mismatch"
	ErrInvalidAuthorizationValue       = "invalid_exact_evm_payload_authorization_value"
	ErrInvalidRequiredAmount           = "invalid_exact_evm_required_amount"
	ErrAuthorizationValueMismatch      = "invalid_exact_evm_payload_authorization_value_mismatch"
	ErrAuthorizationValidBeforeExpired = "invalid_exact_evm_payload_authorization_valid_before"
	ErrAuthorizationValidAfterInFuture = "invalid_exact_evm_payload_authorization_valid_after"
	ErrInsufficientFunds               = "invalid_exact_evm_insufficient_funds"
	ErrInvalidSignatureFormat          = "invalid_exact_evm_signature_format"
	ErrFailedToVerifySignature         = "invalid_exact_evm_failed_to_verify_signature"
	ErrInvalidSignature                = "invalid_exact_evm_payload_signature"

	// Settle errors
	ErrVerificationFailed      = "invalid_exact_evm_verification_failed"
	ErrFailedToParseSignature  = "invalid_exact_evm_failed_to_parse_signature"
	ErrFailedToCheckDeployment = "invalid_exact_evm_failed_to_check_deployment"
	ErrTransactionFailed       = "invalid_exact_evm_transaction_failed"
	ErrFailedToGetReceipt      = "invalid_exact_evm_failed_to_get_receipt"
	ErrInvalidTransactionState = "invalid_exact_evm_transaction_state"

	// Smart wallet errors
	ErrUndeployedSmartWallet       = "invalid_exact_evm_payload_undeployed_smart_wallet"
	ErrSmartWalletDeploymentFailed = "smart_wallet_deployment_failed"
)
