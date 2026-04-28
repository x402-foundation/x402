package client

// Client error constants for the commerce EVM scheme
const (
	ErrInvalidAmount              = "invalid_commerce_evm_client_amount"
	ErrFailedToSignAuthorization  = "invalid_commerce_evm_client_failed_to_sign_authorization"
	ErrMissingEscrowAddress       = "invalid_commerce_evm_client_missing_escrow_address"
	ErrMissingOperatorAddress     = "invalid_commerce_evm_client_missing_operator_address"
	ErrMissingTokenCollector      = "invalid_commerce_evm_client_missing_token_collector"
	ErrMissingTokenName           = "invalid_commerce_evm_client_missing_token_name"
	ErrMissingTokenVersion        = "invalid_commerce_evm_client_missing_token_version"
	ErrFailedToComputeNonce       = "invalid_commerce_evm_client_failed_to_compute_nonce"
	ErrFailedToGetChainID         = "invalid_commerce_evm_client_failed_to_get_chain_id"
)
