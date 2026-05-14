package client

// Client error constants for the authCapture EVM scheme
const (
	ErrInvalidAmount             = "invalid_authcapture_evm_client_amount"
	ErrFailedToSignAuthorization = "invalid_authcapture_evm_client_failed_to_sign_authorization"
	ErrMissingCaptureAuthorizer  = "invalid_authcapture_evm_client_missing_capture_authorizer"
	ErrMissingCaptureDeadline    = "invalid_authcapture_evm_client_missing_capture_deadline"
	ErrMissingRefundDeadline     = "invalid_authcapture_evm_client_missing_refund_deadline"
	ErrMissingFeeRecipient       = "invalid_authcapture_evm_client_missing_fee_recipient"
	ErrMissingMinFeeBps          = "invalid_authcapture_evm_client_missing_min_fee_bps"
	ErrMissingMaxFeeBps          = "invalid_authcapture_evm_client_missing_max_fee_bps"
	ErrMissingTokenName          = "invalid_authcapture_evm_client_missing_token_name"
	ErrMissingTokenVersion       = "invalid_authcapture_evm_client_missing_token_version"
	ErrFailedToComputeNonce      = "invalid_authcapture_evm_client_failed_to_compute_nonce"
	ErrFailedToGetChainID        = "invalid_authcapture_evm_client_failed_to_get_chain_id"
	ErrFailedToGenerateSalt      = "invalid_authcapture_evm_client_failed_to_generate_salt"
	ErrInvalidCaptureDeadline    = "invalid_authcapture_evm_client_invalid_capture_deadline"
	ErrInvalidRefundDeadline     = "invalid_authcapture_evm_client_invalid_refund_deadline"
	ErrInvalidFeeBps             = "invalid_authcapture_evm_client_invalid_fee_bps"
	ErrInvalidFeeBpsRange        = "invalid_authcapture_evm_client_invalid_fee_bps_range"
	ErrInvalidDeadlineOrdering   = "invalid_authcapture_evm_client_invalid_deadline_ordering"
)
