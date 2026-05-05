package server

// Server error constants for the authCapture EVM scheme
const (
	ErrAmountMustBeString      = "invalid_authcapture_evm_server_amount_must_be_string"
	ErrAssetAddressRequired    = "invalid_authcapture_evm_server_asset_address_required"
	ErrFailedToParsePrice      = "invalid_authcapture_evm_server_failed_to_parse_price"
	ErrUnsupportedPriceType    = "invalid_authcapture_evm_server_unsupported_price_type"
	ErrFailedToConvertAmount   = "invalid_authcapture_evm_server_failed_to_convert_amount"
	ErrNoAssetSpecified        = "invalid_authcapture_evm_server_no_asset_specified"
	ErrFailedToParseAmount     = "invalid_authcapture_evm_server_failed_to_parse_amount"
	ErrInvalidPayToAddress     = "invalid_authcapture_evm_server_invalid_payto_address"
	ErrAmountRequired          = "invalid_authcapture_evm_server_amount_required"
	ErrInvalidAmount           = "invalid_authcapture_evm_server_invalid_amount"
	ErrInvalidAsset            = "invalid_authcapture_evm_server_invalid_asset"
	ErrMissingCaptureAuthorizer = "invalid_authcapture_evm_server_missing_capture_authorizer"
	ErrMissingCaptureDeadline  = "invalid_authcapture_evm_server_missing_capture_deadline"
	ErrMissingRefundDeadline   = "invalid_authcapture_evm_server_missing_refund_deadline"
	ErrMissingFeeRecipient     = "invalid_authcapture_evm_server_missing_fee_recipient"
	ErrMissingMinFeeBps        = "invalid_authcapture_evm_server_missing_min_fee_bps"
	ErrMissingMaxFeeBps        = "invalid_authcapture_evm_server_missing_max_fee_bps"
	ErrInvalidCaptureDeadline  = "invalid_authcapture_evm_server_invalid_capture_deadline"
	ErrInvalidRefundDeadline   = "invalid_authcapture_evm_server_invalid_refund_deadline"
	ErrInvalidDeadlineOrdering = "invalid_authcapture_evm_server_invalid_deadline_ordering"
)
