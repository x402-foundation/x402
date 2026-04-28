package server

// Server error constants for the commerce EVM scheme
const (
	ErrAmountMustBeString    = "invalid_commerce_evm_server_amount_must_be_string"
	ErrAssetAddressRequired  = "invalid_commerce_evm_server_asset_address_required"
	ErrFailedToParsePrice    = "invalid_commerce_evm_server_failed_to_parse_price"
	ErrUnsupportedPriceType  = "invalid_commerce_evm_server_unsupported_price_type"
	ErrFailedToConvertAmount = "invalid_commerce_evm_server_failed_to_convert_amount"
	ErrNoAssetSpecified      = "invalid_commerce_evm_server_no_asset_specified"
	ErrFailedToParseAmount   = "invalid_commerce_evm_server_failed_to_parse_amount"
	ErrInvalidPayToAddress   = "invalid_commerce_evm_server_invalid_payto_address"
	ErrAmountRequired        = "invalid_commerce_evm_server_amount_required"
	ErrInvalidAmount         = "invalid_commerce_evm_server_invalid_amount"
	ErrInvalidAsset          = "invalid_commerce_evm_server_invalid_asset"
	ErrInvalidTokenAmount    = "invalid_commerce_evm_server_invalid_token_amount"
	ErrMissingEscrowAddress  = "invalid_commerce_evm_server_missing_escrow_address"
	ErrMissingOperator       = "invalid_commerce_evm_server_missing_operator_address"
	ErrMissingTokenCollector = "invalid_commerce_evm_server_missing_token_collector"
)
