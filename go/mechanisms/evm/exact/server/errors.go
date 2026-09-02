package server

// Server error constants for the exact EVM scheme (V2)
const (
	ErrAmountMustBeString   = "invalid_exact_evm_server_amount_must_be_string"
	ErrAssetAddressRequired = "invalid_exact_evm_server_asset_address_required"
	ErrNoAssetSpecified     = "invalid_exact_evm_server_no_asset_specified"
	ErrFailedToParseAmount  = "invalid_exact_evm_server_failed_to_parse_amount"
)
