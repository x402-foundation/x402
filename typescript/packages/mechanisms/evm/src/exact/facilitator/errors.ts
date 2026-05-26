/**
 * Named error reason constants for the exact EVM facilitator.
 *
 * These strings must be character-for-character identical to the Go constants in
 * go/mechanisms/evm/exact/facilitator/errors.go to maintain cross-SDK parity.
 */

export const ErrInvalidScheme = "invalid_exact_evm_scheme";
export const ErrNetworkMismatch = "invalid_exact_evm_network_mismatch";
export const ErrMissingEip712Domain = "invalid_exact_evm_missing_eip712_domain";
export const ErrRecipientMismatch = "invalid_exact_evm_recipient_mismatch";
export const ErrInvalidSignature = "invalid_exact_evm_signature";
export const ErrValidBeforeExpired = "invalid_exact_evm_payload_authorization_valid_before";
export const ErrValidAfterInFuture = "invalid_exact_evm_payload_authorization_valid_after";
export const ErrInvalidAuthorizationValue = "invalid_exact_evm_authorization_value";
export const ErrUndeployedSmartWallet = "invalid_exact_evm_payload_undeployed_smart_wallet";
export const ErrTransactionFailed = "invalid_exact_evm_transaction_failed";

// EIP-3009 verify errors
export const ErrEip3009TokenNameMismatch = "invalid_exact_evm_token_name_mismatch";
export const ErrEip3009TokenVersionMismatch = "invalid_exact_evm_token_version_mismatch";
export const ErrEip3009NotSupported = "invalid_exact_evm_eip3009_not_supported";
export const ErrEip3009NonceAlreadyUsed = "invalid_exact_evm_nonce_already_used";
export const ErrEip3009InsufficientBalance = "invalid_exact_evm_insufficient_balance";
export const ErrEip3009SimulationFailed = "invalid_exact_evm_transaction_simulation_failed";

// Permit2 verify errors
export const ErrPermit2InvalidSpender = "invalid_permit2_spender";
export const ErrPermit2RecipientMismatch = "invalid_permit2_recipient_mismatch";
export const ErrPermit2DeadlineExpired = "permit2_deadline_expired";
export const ErrPermit2NotYetValid = "permit2_not_yet_valid";
export const ErrPermit2AmountMismatch = "permit2_amount_mismatch";
export const ErrPermit2TokenMismatch = "permit2_token_mismatch";
export const ErrPermit2InvalidSignature = "invalid_permit2_signature";
export const ErrPermit2AllowanceRequired = "permit2_allowance_required";
export const ErrPermit2SimulationFailed = "permit2_simulation_failed";
export const ErrPermit2InsufficientBalance = "permit2_insufficient_balance";
export const ErrPermit2ProxyNotDeployed = "permit2_proxy_not_deployed";

// Permit2 settle errors (from contract reverts)
export const ErrPermit2InvalidAmount = "permit2_invalid_amount";
export const ErrPermit2InvalidDestination = "permit2_invalid_destination";
export const ErrPermit2InvalidOwner = "permit2_invalid_owner";
export const ErrPermit2PaymentTooEarly = "permit2_payment_too_early";
export const ErrPermit2InvalidNonce = "permit2_invalid_nonce";
export const ErrPermit2612AmountMismatch = "permit2_2612_amount_mismatch";

// ERC-20 approval gas sponsoring verify errors
export const ErrErc20ApprovalInvalidFormat = "invalid_erc20_approval_extension_format";
export const ErrErc20ApprovalFromMismatch = "erc20_approval_from_mismatch";
export const ErrErc20ApprovalAssetMismatch = "erc20_approval_asset_mismatch";
export const ErrErc20ApprovalSpenderNotPermit2 = "erc20_approval_spender_not_permit2";
export const ErrErc20ApprovalTxWrongTarget = "erc20_approval_tx_wrong_target";
export const ErrErc20ApprovalTxWrongSelector = "erc20_approval_tx_wrong_selector";
export const ErrErc20ApprovalTxWrongSpender = "erc20_approval_tx_wrong_spender";
export const ErrErc20ApprovalTxInvalidCalldata = "erc20_approval_tx_invalid_calldata";
export const ErrErc20ApprovalTxSignerMismatch = "erc20_approval_tx_signer_mismatch";
export const ErrErc20ApprovalTxInvalidSignature = "erc20_approval_tx_invalid_signature";
export const ErrErc20ApprovalTxParseFailed = "erc20_approval_tx_parse_failed";
export const ErrErc20ApprovalTxFailed = "erc20_approval_tx_failed";

// EIP-2612 gas sponsoring verify errors
export const ErrInvalidEip2612ExtensionFormat = "invalid_eip2612_extension_format";
export const ErrEip2612FromMismatch = "eip2612_from_mismatch";
export const ErrEip2612AssetMismatch = "eip2612_asset_mismatch";
export const ErrEip2612SpenderNotPermit2 = "eip2612_spender_not_permit2";
export const ErrEip2612DeadlineExpired = "eip2612_deadline_expired";

// Shared settle errors
export const ErrUnsupportedPayloadType = "unsupported_payload_type";
export const ErrInvalidTransactionState = "invalid_transaction_state";
