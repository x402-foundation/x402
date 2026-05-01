// Package batched holds shared batch-settlement error constants used across
// client / facilitator / server. Two prefix categories live here:
//
//  1. `invalid_batch_settlement_evm_*` — facilitator-emitted rejection tokens.
//     These mirror values defined in
//     `go/mechanisms/evm/batched/facilitator/errors.go` (and must stay
//     bit-identical) so client code and tests can reference them without
//     importing the facilitator package (which would create a cycle).
//     Map 1:1 onto CDP Accounts API enums.
//
//  2. `batch_settlement_*` (no `_evm_`) — resource-server-emitted abort
//     reasons that flow back via PAYMENT-REQUIRED 402 corrective handshakes.
//     These are NOT facilitator output and are intentionally on a sibling
//     prefix so cdp-facilitator's `MapBatchSDKReasonToCDP` (or its successor)
//     can route facilitator vs server reasons separately without substring
//     ambiguity.
//
// Renaming any of these breaks wire compatibility — update CDP enums + any
// substring-matching consumers in the same change.
package batched

const (
	// ── (1) Facilitator-emitted reasons (mirror facilitator/errors.go) ────

	ErrInvalidPayload     = "invalid_batch_settlement_evm_payload_type"
	ErrInvalidAmount      = "invalid_batch_settlement_evm_amount"
	ErrInvalidChannelId   = "invalid_batch_settlement_evm_channel_id_mismatch"
	ErrInvalidChannelConf = "invalid_batch_settlement_evm_channel_config"
	ErrChannelNotFound    = "invalid_batch_settlement_evm_channel_not_found"

	// ErrCumulativeBelowClaimed is the canonical value of
	// `facilitator.ErrMaxClaimableTooLow`. Surfaced both by the facilitator
	// (as a verify rejection) AND by the resource server's corrective 402
	// recovery handshake — clients accept it as a signal to refresh
	// channel state and retry. Defined here so `client/scheme.go` can match
	// it without importing the facilitator package (which would cycle:
	// facilitator already imports batched).
	ErrCumulativeBelowClaimed = "invalid_batch_settlement_evm_cumulative_below_claimed"

	// ── (2) Resource-server-emitted reasons (sibling prefix) ──────────────

	// ErrCumulativeAmountMismatch signals a recoverable 402 from the resource
	// server when the client's signed cumulative disagrees with the server's
	// tracked state. The resource server emits this from its `BeforeSettleHook`
	// (NOT the facilitator), so it lives on the `batch_settlement_*` sibling
	// prefix rather than `invalid_batch_settlement_evm_*`. Clients refresh
	// from the corrective ChannelState in requirements.extra and retry.
	ErrCumulativeAmountMismatch = "batch_settlement_cumulative_amount_mismatch"
)
