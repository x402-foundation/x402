package server

// Server error constants for the exact EVM scheme (V2)
const (
	ErrAmountMustBeString    = "invalid_exact_evm_server_amount_must_be_string"
	ErrAssetAddressRequired  = "invalid_exact_evm_server_asset_address_required"
	ErrFailedToParsePrice    = "invalid_exact_evm_server_failed_to_parse_price"
	ErrUnsupportedPriceType  = "invalid_exact_evm_server_unsupported_price_type"
	ErrFailedToConvertAmount = "invalid_exact_evm_server_failed_to_convert_amount"
	ErrNoAssetSpecified      = "invalid_exact_evm_server_no_asset_specified"
	ErrFailedToParseAmount   = "invalid_exact_evm_server_failed_to_parse_amount"
	ErrInvalidPayToAddress   = "invalid_exact_evm_server_invalid_payto_address"
	ErrAmountRequired        = "invalid_exact_evm_server_amount_required"
	ErrInvalidAmount         = "invalid_exact_evm_server_invalid_amount"
	ErrInvalidAsset          = "invalid_exact_evm_server_invalid_asset"
	ErrInvalidTokenAmount    = "invalid_exact_evm_server_invalid_token_amount"
)
