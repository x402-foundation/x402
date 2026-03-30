package facilitator

import "github.com/coinbase/x402/go/mechanisms/evm"

// Facilitator error constants for the exact EVM scheme
const (
	// EIP-3009 Verify errors
	ErrInvalidScheme               = "invalid_exact_evm_scheme"
	ErrNetworkMismatch             = "invalid_exact_evm_network_mismatch"
	ErrInvalidPayload              = "invalid_exact_evm_payload"
	ErrMissingSignature            = "invalid_exact_evm_payload_missing_signature"
	ErrFailedToGetNetworkConfig    = "invalid_exact_evm_failed_to_get_network_config"
	ErrMissingEip712Domain         = "invalid_exact_evm_missing_eip712_domain"
	ErrRecipientMismatch           = "invalid_exact_evm_recipient_mismatch"
	ErrInvalidAuthorizationValue   = "invalid_exact_evm_authorization_value"
	ErrInvalidRequiredAmount       = "invalid_exact_evm_required_amount"
	ErrAuthorizationValueMismatch  = "invalid_exact_evm_payload_authorization_value_mismatch"
	ErrFailedToCheckNonce          = "invalid_exact_evm_failed_to_check_nonce"
	ErrNonceAlreadyUsed            = "invalid_exact_evm_nonce_already_used"
	ErrFailedToGetBalance          = "invalid_exact_evm_failed_to_get_balance"
	ErrInsufficientBalance         = "invalid_exact_evm_insufficient_balance"
	ErrInvalidSignatureFormat      = "invalid_exact_evm_signature_format"
	ErrFailedToVerifySignature     = "invalid_exact_evm_failed_to_verify_signature"
	ErrInvalidSignature            = "invalid_exact_evm_signature"
	ErrValidBeforeExpired          = "invalid_exact_evm_payload_authorization_valid_before"
	ErrValidAfterInFuture          = "invalid_exact_evm_payload_authorization_valid_after"
	ErrEip3009TokenNameMismatch    = "invalid_exact_evm_token_name_mismatch"
	ErrEip3009TokenVersionMismatch = "invalid_exact_evm_token_version_mismatch"
	ErrEip3009NotSupported         = "invalid_exact_evm_eip3009_not_supported"
	ErrEip3009SimulationFailed     = "invalid_exact_evm_transaction_simulation_failed"

	// EIP-3009 Settle errors
	ErrVerificationFailed      = "invalid_exact_evm_verification_failed"
	ErrFailedToParseSignature  = "invalid_exact_evm_failed_to_parse_signature"
	ErrFailedToCheckDeployment = "invalid_exact_evm_failed_to_check_deployment"
	ErrFailedToExecuteTransfer = "invalid_exact_evm_failed_to_execute_transfer"
	ErrFailedToGetReceipt      = "invalid_exact_evm_failed_to_get_receipt"
	ErrTransactionFailed       = "invalid_exact_evm_transaction_failed"

	// Smart wallet errors (shared by EIP-3009 and Permit2)
	ErrUndeployedSmartWallet       = "invalid_exact_evm_payload_undeployed_smart_wallet"
	ErrSmartWalletDeploymentFailed = "smart_wallet_deployment_failed"
	ErrUnsupportedPayloadType      = "unsupported_payload_type"

	// Permit2 verify errors — canonical values live in evm.ErrPermit2*
	ErrPermit2InvalidSpender    = evm.ErrPermit2InvalidSpender
	ErrPermit2RecipientMismatch = evm.ErrPermit2RecipientMismatch
	ErrPermit2DeadlineExpired   = evm.ErrPermit2DeadlineExpired
	ErrPermit2NotYetValid       = evm.ErrPermit2NotYetValid
	ErrPermit2AmountMismatch    = evm.ErrPermit2AmountMismatch
	ErrPermit2TokenMismatch     = evm.ErrPermit2TokenMismatch
	ErrPermit2InvalidSignature  = evm.ErrPermit2InvalidSignature
	ErrPermit2AllowanceRequired = evm.ErrPermit2AllowanceRequired

	// Permit2 settle errors (from contract reverts)
	ErrPermit2InvalidAmount      = evm.ErrPermit2InvalidAmount
	ErrPermit2InvalidDestination = evm.ErrPermit2InvalidDestination
	ErrPermit2InvalidOwner       = evm.ErrPermit2InvalidOwner
	ErrPermit2PaymentTooEarly    = evm.ErrPermit2PaymentTooEarly
	ErrPermit2InvalidNonce       = evm.ErrPermit2InvalidNonce
	ErrPermit2612AmountMismatch  = evm.ErrPermit2612AmountMismatch

	// Permit2 simulation errors
	ErrPermit2SimulationFailed    = evm.ErrPermit2SimulationFailed
	ErrPermit2InsufficientBalance = evm.ErrPermit2InsufficientBalance
	ErrPermit2ProxyNotDeployed    = evm.ErrPermit2ProxyNotDeployed
	ErrErc20ApprovalTxFailed      = "erc20_approval_tx_failed"

	// ERC-20 approval gas sponsoring errors
	ErrErc20ApprovalInsufficientEth = evm.ErrErc20ApprovalInsufficientEth
	ErrErc20ApprovalInvalidFormat   = "invalid_erc20_approval_extension_format"
	ErrErc20ApprovalFromMismatch    = "erc20_approval_from_mismatch"
	ErrErc20ApprovalAssetMismatch   = "erc20_approval_asset_mismatch"
	ErrErc20ApprovalWrongSpender    = "erc20_approval_spender_not_permit2"
	ErrErc20ApprovalTxParseFailed   = "erc20_approval_tx_parse_failed"
	ErrErc20ApprovalWrongTarget     = "erc20_approval_tx_wrong_target"
	ErrErc20ApprovalWrongSelector   = "erc20_approval_tx_wrong_selector"
	ErrErc20ApprovalWrongCalldata   = "erc20_approval_tx_wrong_spender"
	ErrErc20ApprovalSignerMismatch  = "erc20_approval_tx_signer_mismatch"
	ErrErc20ApprovalInvalidSig      = "erc20_approval_tx_invalid_signature"
	ErrErc20ApprovalBroadcastFailed = evm.ErrErc20ApprovalBroadcastFailed
)
