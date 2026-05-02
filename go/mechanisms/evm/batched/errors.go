// Package batched holds shared batch-settlement error constants used across
// client / facilitator / server. Two prefix families live here:
//
//   - `invalid_batch_settlement_evm_*` — the single facilitator-emitted reason
//     (`ErrCumulativeBelowClaimed`) that the client must also match against,
//     duplicated here so `client/scheme.go` can reference it without
//     importing the facilitator package (which would cycle: facilitator
//     already imports batched). All other facilitator-emitted reasons live
//     exclusively in `go/mechanisms/evm/batched/facilitator/errors.go`.
//
//   - `batch_settlement_*` / `missing_*` — resource-server-emitted abort
//     reasons surfaced through PAYMENT-REQUIRED 402 `error` fields. The
//     distinct prefix keeps them lexically separable from facilitator
//     output for substring-based classifiers.
//
// All wire strings here describe mechanism-level failures only and carry
// no policy/business semantics.
package batched

const (
	// ── (1) Facilitator-emitted reason shared with the client ─────────────

	// ErrCumulativeBelowClaimed is the canonical value of
	// `facilitator.ErrMaxClaimableTooLow`. Surfaced both by the facilitator
	// (as a verify rejection) AND by the resource server's corrective 402
	// recovery handshake — clients accept it as a signal to refresh
	// channel state and retry. Defined here so `client/scheme.go` can match
	// it without importing the facilitator package.
	ErrCumulativeBelowClaimed = "invalid_batch_settlement_evm_cumulative_below_claimed"

	// ── (2) Resource-server-emitted reasons (sibling prefix) ──────────────
	//
	// Emitted by the resource server's lifecycle hooks (BeforeVerifyHook /
	// BeforeSettleHook / AfterVerifyHook) and surfaced to the client
	// through the PAYMENT-REQUIRED 402 `error` field. NOT facilitator
	// output.

	// ErrCumulativeAmountMismatch signals a recoverable 402 from the resource
	// server when the client's signed cumulative disagrees with the server's
	// tracked state. Clients refresh from the corrective ChannelState in
	// requirements.extra and retry.
	ErrCumulativeAmountMismatch = "batch_settlement_cumulative_amount_mismatch"

	// ErrChannelBusy signals that another request is currently holding the
	// per-channel concurrency lock. Clients should back off briefly and
	// retry. Emitted by BeforeSettleHook for both voucher commits and
	// refund rewrites when a pending request is in flight.
	ErrChannelBusy = "batch_settlement_channel_busy"

	// ErrMissingChannel signals that the server has no record of the
	// channel referenced by the payload. Differs in shape from the rest of
	// the sibling-prefix family (`missing_*` envelope, not `batch_settlement_*`)
	// to match the TS resource server byte-for-byte. Emitted by
	// BeforeSettleHook for voucher and refund payloads when no session
	// exists for the computed channelId.
	ErrMissingChannel = "missing_batch_settlement_channel"

	// ErrChargeExceedsSignedCumulative signals that committing this voucher
	// would push the server-tracked chargedCumulativeAmount above the
	// voucher's signed maxClaimableAmount cap. Emitted by BeforeSettleHook's
	// voucher-commit path; clients must re-sign with a larger cap.
	ErrChargeExceedsSignedCumulative = "batch_settlement_charge_exceeds_signed_cumulative"

	// ErrRefundNoBalance signals that a cooperative refund request hit a
	// channel with no remaining refundable balance (post-claim). Non-
	// recoverable — the client must abandon the refund. Emitted by
	// BeforeSettleHook's refund-rewrite path.
	ErrRefundNoBalance = "batch_settlement_refund_no_balance"

	// ErrRefundAmountInvalid signals the client requested a malformed refund
	// amount (non-numeric or non-positive). Non-recoverable — the client
	// must fix the request before retrying.
	ErrRefundAmountInvalid = "batch_settlement_refund_amount_invalid"

	// ErrRefundAmountExceedsBalance signals the client requested a refund
	// larger than the channel's available balance. Non-recoverable; client
	// should retry with a smaller amount or omit `amount` for a full refund.
	ErrRefundAmountExceedsBalance = "batch_settlement_refund_amount_exceeds_balance"
)
