package facilitator

// Facilitator error codes for the SVM `upto` payment-channel scheme.
const (
	// Shared protocol-level codes.
	ErrUnsupportedScheme      = "unsupported_scheme"
	ErrUnsupportedPayloadType = "unsupported_payload_type"
	ErrNetworkMismatch        = "network_mismatch"
	ErrFacilitatorMismatch    = "facilitator_mismatch"
	ErrDuplicateSettlement    = "duplicate_settlement"
	ErrTransactionFailed      = "transaction_failed"

	// Payload-level codes.

	// ErrUnexpectedVoucher is returned when a client supplies the server-owned,
	// claim-only voucherSignature key at verify or deposit settle.
	ErrUnexpectedVoucher = "invalid_upto_svm_payload_unexpected_voucher"
	// ErrSettlementExceedsAmount is returned when the charge exceeds the signed ceiling.
	ErrSettlementExceedsAmount = "invalid_upto_svm_payload_settlement_exceeds_amount"
	// ErrMissingVoucher is returned for a partial charge with no voucher.
	ErrMissingVoucher = "invalid_upto_svm_payload_missing_voucher"
	// ErrPayloadAmount is returned when an amount field is not an unsigned integer.
	ErrPayloadAmount = "invalid_upto_svm_payload_amount"
	// ErrAmountMismatch is returned when payload.maxAmount != requirements.amount.
	ErrAmountMismatch = "invalid_upto_svm_payload_amount_mismatch"
	// ErrDepositNotCeiling is returned when payload.deposit != payload.maxAmount.
	ErrDepositNotCeiling = "invalid_upto_svm_payload_deposit_not_ceiling"
	// ErrChannelSeed is returned when a channel PDA seed (openSlot/nonce) is malformed.
	ErrChannelSeed = "invalid_upto_svm_payload_channel_seed"
	// ErrNotYetActive is returned before payload.validAfter.
	ErrNotYetActive = "invalid_upto_svm_payload_not_yet_active"
	// ErrExpired is returned at or after payload.expiresAt.
	ErrExpired = "invalid_upto_svm_payload_expired"
	// ErrChannelLifetimeExceeded is returned when the requested channel lifetime
	// exceeds the facilitator's cap.
	ErrChannelLifetimeExceeded = "invalid_upto_svm_payload_channel_lifetime_exceeded"
	// ErrExpiresAtMismatch is returned when expiresAt exceeds now + maxTimeoutSeconds.
	ErrExpiresAtMismatch = "invalid_upto_svm_payload_expires_at_mismatch"
	// ErrOpenTransaction is returned when the open transaction fails the acceptance policy.
	ErrOpenTransaction = "invalid_upto_svm_payload_open_transaction"
	// ErrChannelID is returned when the open's channel PDA != payload.channelId.
	ErrChannelID = "invalid_upto_svm_payload_channel_id"
	// ErrNonce is returned when the open's salt != payload.nonce.
	ErrNonce = "invalid_upto_svm_payload_nonce"
	// ErrPayerMismatch is returned when the open's payer != payload.from.
	ErrPayerMismatch = "invalid_upto_svm_payload_payer_mismatch"
	// ErrReceiverAuthorizer is returned when payload.authorizedSigner is not the
	// receiverAuthorizer pinned by the requirements.
	ErrReceiverAuthorizer = "invalid_upto_svm_payload_receiver_authorizer"
	// ErrVoucherSignature is returned when the voucher is not signed by the authorizer.
	ErrVoucherSignature = "invalid_upto_svm_payload_voucher_signature"

	// Channel and settlement codes.

	// ErrChannelAlreadyOpen is returned when a deposit settle targets an existing PDA.
	ErrChannelAlreadyOpen = "invalid_upto_svm_channel_already_open"
	// ErrChannelState is returned when the onchain channel does not match the challenge.
	ErrChannelState = "invalid_upto_svm_channel_state"
	// ErrChannelBroadcast is returned when the open transaction fails to
	// broadcast, or when the pre-broadcast durable channel index fails: in
	// both cases nothing has reached the chain and the deposit is safe to retry.
	ErrChannelBroadcast = "invalid_upto_svm_channel_broadcast"
	// ErrSettlementSimulation is returned when the pre-broadcast settlement
	// simulation fails, so the deposit is never escrowed.
	ErrSettlementSimulation = "invalid_upto_svm_settlement_simulation"
	// ErrPaymentRequirements is returned when the requirements are unusable.
	ErrPaymentRequirements = "invalid_upto_svm_payment_requirements"
)
