package server

// Server error constants for the SVM `upto` payment-channel scheme
const (
	ErrAmountMustBeString    = "invalid_upto_svm_server_amount_must_be_string"
	ErrInvalidPriceFormat    = "invalid_upto_svm_server_invalid_price_format"
	ErrFailedToParsePrice    = "invalid_upto_svm_server_failed_to_parse_price"
	ErrFailedToConvertAmount = "invalid_upto_svm_server_failed_to_convert_amount"
	ErrFailedToParseAmount   = "invalid_upto_svm_server_failed_to_parse_amount"
	ErrAuthorizerMismatch    = "invalid_upto_svm_server_authorizer_mismatch"
	ErrInvalidPayload        = "invalid_upto_svm_server_invalid_payload"
	ErrFailedToSignVoucher   = "invalid_upto_svm_server_failed_to_sign_voucher"
)
