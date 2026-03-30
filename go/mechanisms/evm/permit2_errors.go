package evm

// Shared Permit2 error constants used by both the exact and upto facilitators.
// Both schemes write these strings to JSON responses and facilitate cross-SDK parity,
// so the values must never change without a coordinated update across all SDKs.
const (
	// Verification errors
	ErrPermit2InvalidSpender    = "invalid_permit2_spender"
	ErrPermit2RecipientMismatch = "invalid_permit2_recipient_mismatch"
	ErrPermit2DeadlineExpired   = "permit2_deadline_expired"
	ErrPermit2NotYetValid       = "permit2_not_yet_valid"
	ErrPermit2AmountMismatch    = "permit2_amount_mismatch"
	ErrPermit2TokenMismatch     = "permit2_token_mismatch"
	ErrPermit2InvalidSignature  = "invalid_permit2_signature"
	ErrPermit2AllowanceRequired = "permit2_allowance_required"

	// Settle errors (from contract reverts)
	ErrPermit2InvalidAmount      = "permit2_invalid_amount"
	ErrPermit2InvalidDestination = "permit2_invalid_destination"
	ErrPermit2InvalidOwner       = "permit2_invalid_owner"
	ErrPermit2PaymentTooEarly    = "permit2_payment_too_early"
	ErrPermit2InvalidNonce       = "permit2_invalid_nonce"
	ErrPermit2612AmountMismatch  = "permit2_2612_amount_mismatch"

	// Simulation errors
	ErrPermit2SimulationFailed    = "permit2_simulation_failed"
	ErrPermit2InsufficientBalance = "permit2_insufficient_balance"
	ErrPermit2ProxyNotDeployed    = "permit2_proxy_not_deployed"

	// ERC-20 approval gas-sponsoring errors
	ErrErc20ApprovalInsufficientEth = "erc20_approval_insufficient_eth_for_gas"
	ErrErc20ApprovalBroadcastFailed = "erc20_approval_broadcast_failed"
)
