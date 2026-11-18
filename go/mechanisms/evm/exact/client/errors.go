package client

// Client error constants for the exact EVM scheme (V2)
const (
	ErrInvalidAmount                    = "invalid_exact_evm_client_amount"
	ErrFailedToSignAuthorization        = "invalid_exact_evm_client_failed_to_sign_authorization"
	ErrFailedToSignPermit2Authorization = "invalid_exact_evm_client_failed_to_sign_permit2_authorization"
)
