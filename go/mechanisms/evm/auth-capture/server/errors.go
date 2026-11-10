package server

// Server error constants for the auth-capture EVM scheme.
const (
	ErrAmountMustBeString            = "invalid_auth_capture_evm_server_amount_must_be_string"
	ErrNoAssetSpecified              = "invalid_auth_capture_evm_server_no_asset_specified"
	ErrFailedToParseAmount           = "invalid_auth_capture_evm_server_failed_to_parse_amount"
	ErrMissingCaptureAuthorizer      = "invalid_auth_capture_evm_server_missing_capture_authorizer"
	ErrMissingFeeRecipient           = "invalid_auth_capture_evm_server_missing_fee_recipient"
	ErrInvalidFeeTerms               = "invalid_auth_capture_evm_server_invalid_fee_terms"
	ErrTimeoutExceedsCaptureDeadline = "invalid_auth_capture_evm_server_timeout_exceeds_capture_deadline"
	ErrRefundBeforeCaptureDeadline   = "invalid_auth_capture_evm_server_refund_before_capture_deadline"
	ErrMissingReceiverAuthorizer     = "invalid_auth_capture_evm_server_missing_receiver_authorizer"
	ErrUnsignableReceiverAuthorizer  = "invalid_auth_capture_evm_server_unsignable_receiver_authorizer"
	ErrInvalidCollectPayload         = "invalid_auth_capture_evm_server_invalid_collect_payload"
	ErrInvalidCaptureAmount          = "invalid_auth_capture_evm_server_invalid_capture_amount"
	ErrFailedToSignCapture           = "invalid_auth_capture_evm_server_failed_to_sign_capture"
	ErrFailedToSignVoid              = "invalid_auth_capture_evm_server_failed_to_sign_void"
	ErrFailedToSignCharge            = "invalid_auth_capture_evm_server_failed_to_sign_charge"
	ErrFailedToSignRefund            = "invalid_auth_capture_evm_server_failed_to_sign_refund"
	ErrInvalidRouteExtra             = "invalid_auth_capture_evm_server_invalid_route_extra"
	ErrInvalidDeadline               = "invalid_auth_capture_evm_server_invalid_deadline"
	ErrOperatorNotAdmitted           = "invalid_auth_capture_evm_server_operator_not_admitted"
	ErrAutoCaptureRemoved            = "invalid_auth_capture_evm_server_auto_capture_removed"
	ErrReceiverAuthorizerMismatch    = "invalid_auth_capture_evm_server_receiver_authorizer_mismatch"
	ErrPaymentNotFound               = "invalid_auth_capture_evm_server_payment_not_found"
	ErrLifecycleUnavailable          = "invalid_auth_capture_evm_server_lifecycle_unavailable"
	ErrInvalidLifecycleAmount        = "invalid_auth_capture_evm_server_invalid_lifecycle_amount"
)
