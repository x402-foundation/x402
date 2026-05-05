package facilitator

// Facilitator error constants for the authCapture EVM scheme
const (
	// Verify errors
	ErrInvalidScheme                  = "invalid_authcapture_evm_scheme"
	ErrNetworkMismatch                = "invalid_authcapture_evm_network_mismatch"
	ErrInvalidPayload                 = "invalid_payload_format"
	ErrMissingSignature               = "invalid_authcapture_evm_payload_missing_signature"
	ErrMissingSalt                    = "invalid_authcapture_evm_payload_missing_salt"
	ErrFailedToGetNetworkConfig       = "invalid_authcapture_evm_failed_to_get_network_config"
	ErrMissingEip712Domain            = "invalid_authcapture_evm_missing_eip712_domain"
	ErrInvalidSignatureFormat         = "invalid_authcapture_evm_signature_format"
	ErrFailedToVerifySignature        = "invalid_authcapture_evm_failed_to_verify_signature"
	ErrInvalidSignature               = "invalid_authCapture_signature"
	ErrValidBeforeExpired             = "authorization_expired"
	ErrValidAfterInFuture             = "authorization_not_yet_valid"
	ErrMissingExtraFields             = "invalid_authCapture_extra"
	ErrUnsupportedAssetTransferMethod = "unsupported_asset_transfer_method"
	ErrPayloadMethodMismatch          = "payload_method_mismatch"
	ErrCaptureDeadlineExpired         = "capture_deadline_expired"
	ErrInvalidDeadlineOrdering        = "invalid_deadline_ordering"
	ErrTokenCollectorMismatch         = "token_collector_mismatch"
	ErrTokenMismatch                  = "token_mismatch"
	ErrAmountMismatch                 = "amount_mismatch"
	ErrNonceMismatch                  = "nonce_mismatch"
	ErrInvalidAuthorizationValue      = "invalid_authcapture_evm_authorization_value"
	ErrInvalidRequiredAmount          = "invalid_authcapture_evm_required_amount"
	ErrInvalidNetworkFormat           = "invalid_network"

	// Settle errors
	ErrVerificationFailed     = "verification_failed"
	ErrFailedToParseSignature = "invalid_authcapture_evm_failed_to_parse_signature"
	ErrFailedToExecuteSettle  = "invalid_authcapture_evm_failed_to_execute_settle"
	ErrFailedToGetReceipt     = "invalid_authcapture_evm_failed_to_get_receipt"
	ErrTransactionFailed      = "transaction_reverted"
)
