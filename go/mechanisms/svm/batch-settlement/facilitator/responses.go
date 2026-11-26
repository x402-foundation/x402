package facilitator

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
	"github.com/x402-foundation/x402/go/v2/types"
)

// InvalidPaymentRequirements is the core x402 reason for a
// paymentPayload.accepted that does not equal the requirements.
const InvalidPaymentRequirements = "invalid_payment_requirements"

// UnexpectedSettleError is the non-terminal fallback reason for an unclassified
// settlement error when a caller asks ClassifyError for a reason string.
const UnexpectedSettleError = "unexpected_settle_error"

var transientPattern = regexp.MustCompile(`(?i)\b429\b|\b503\b|too many requests`)

const extraPaidToReceiver = "paidToReceiver"

// EnvelopeFailure reports when accepted differs from requirements (spec 4.5),
// ignoring batchsettlement.DynamicExtraFields. Empty means they match.
func EnvelopeFailure(accepted, requirements types.PaymentRequirements) string {
	if accepted.Scheme != batchsettlement.Scheme || requirements.Scheme != batchsettlement.Scheme {
		return "unsupported_scheme"
	}
	if !x402.DeepEqual(comparableRequirements(accepted), comparableRequirements(requirements)) {
		return InvalidPaymentRequirements
	}
	return ""
}

// settleEnvelopeFailure binds only scheme and network: a settlement override lowers
// requirements.Amount below accepted.Amount, and the charge checks bound it by the payer's proof.
func settleEnvelopeFailure(accepted, requirements types.PaymentRequirements) string {
	if accepted.Scheme != batchsettlement.Scheme || requirements.Scheme != batchsettlement.Scheme {
		return "unsupported_scheme"
	}
	if accepted.Network != requirements.Network {
		return InvalidPaymentRequirements
	}
	return ""
}

func comparableRequirements(requirements types.PaymentRequirements) types.PaymentRequirements {
	extra := make(map[string]interface{}, len(requirements.Extra))
	for key, value := range requirements.Extra {
		extra[key] = value
	}
	for _, field := range batchsettlement.DynamicExtraFields {
		delete(extra, field)
	}
	requirements.Extra = extra
	return requirements
}

// PendingSignatureOf returns the signature carried by an error that means the
// broadcast's outcome is unknown. A transaction that failed onchain has a known
// outcome, even when a broadcast wraps it, so it carries none.
func PendingSignatureOf(err error) (string, bool) {
	var onchain *svm.TransactionOnchainFailureError
	if errors.As(err, &onchain) {
		return "", false
	}
	var confirm *paymentchannels.ChannelBroadcastConfirmationError
	if errors.As(err, &confirm) {
		return confirm.Signature, confirm.Signature != ""
	}
	var timeout *paymentchannels.SettlementConfirmationTimeoutError
	if errors.As(err, &timeout) {
		return timeout.Signature, timeout.Signature != ""
	}
	return "", false
}

func snapshotChannel(channelID string, channel *generated.Channel) batchsettlement.BatchChannelState {
	snapshot := batchsettlement.BatchChannelState{
		ChannelID:    channelID,
		Balance:      strconv.FormatUint(channel.Deposit, 10),
		TotalClaimed: strconv.FormatUint(channel.Settlement.Settled, 10),
	}
	if generated.ChannelStatus(channel.Status) == generated.ChannelStatus_Closing {
		snapshot.WithdrawRequestedAt = channel.ClosureStartedAt
	}
	return snapshot
}

// redemptionSnapshot leaves Status empty for an unrecognized onchain status; the server rejects it.
func redemptionSnapshot(channelID string, channel *generated.Channel) batchsettlement.BatchRedemptionChannelState {
	state := batchsettlement.BatchRedemptionChannelState{
		ChannelID:       channelID,
		Status:          batchsettlement.RedemptionStatus(generated.ChannelStatus(channel.Status)),
		Balance:         strconv.FormatUint(channel.Deposit, 10),
		TotalClaimed:    strconv.FormatUint(channel.Settlement.Settled, 10),
		PayoutWatermark: strconv.FormatUint(channel.Settlement.PayoutWatermark, 10),
	}
	if state.Status == batchsettlement.ChannelStatusClosing {
		state.WithdrawRequestedAt = channel.ClosureStartedAt
	}
	return state
}

// distributedSnapshot is the state a confirmed distribute leaves behind: payout caught up to settled, and a sealed channel paid out.
// It is valid only for a channel read before that distribute was built; a channel read after
// may have settled more since, so use redemptionSnapshot for one.
func distributedSnapshot(channelID string, channel *generated.Channel) batchsettlement.BatchRedemptionChannelState {
	state := redemptionSnapshot(channelID, channel)
	state.PayoutWatermark = state.TotalClaimed
	if state.Status == batchsettlement.ChannelStatusSealed {
		state.Status = batchsettlement.ChannelStatusDistributed
	}
	return state
}

// ResyncFailure rejects a redemption whose effect is already onchain and carries the channels' state, so the server adopts it instead of resubmitting.
func ResyncFailure(network x402.Network, reason, message string, states []batchsettlement.BatchRedemptionChannelState) *x402.SettleResponse {
	response := SettleFailure(network, reason, "", message)
	response.Extra = map[string]any{batchsettlement.ExtraChannelStates: states}
	return response
}

// VerifiedChannelExtra projects a channel onto the flat verify response extra.
func VerifiedChannelExtra(channelID string, channel *generated.Channel) map[string]any {
	snapshot := snapshotChannel(channelID, channel)
	return map[string]any{
		"channelId":           snapshot.ChannelID,
		"balance":             snapshot.Balance,
		"totalClaimed":        snapshot.TotalClaimed,
		"withdrawRequestedAt": snapshot.WithdrawRequestedAt,
	}
}

// DepositResponse is a successful deposit settlement with the confirmed channel state.
func DepositResponse(channelID string, channel *generated.Channel, network x402.Network, transaction string, amount uint64) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     true,
		Payer:       channel.Payer.String(),
		Transaction: transaction,
		Network:     network,
		Amount:      strconv.FormatUint(amount, 10),
		Extra: map[string]any{
			"channelState": snapshotChannel(channelID, channel),
		},
	}
}

// ClaimResponse is a successful claim listing every channel and the cumulative it advanced to.
func ClaimResponse(claims []PreparedClaim, network x402.Network, transaction string) *x402.SettleResponse {
	accepts := make([]any, len(claims))
	for i, claim := range claims {
		accepts[i] = map[string]any{
			"channelId":    claim.ChannelID,
			"totalClaimed": strconv.FormatUint(claim.Cumulative, 10),
		}
	}
	return &x402.SettleResponse{
		Success:     true,
		Transaction: transaction,
		Network:     network,
		Extra:       map[string]any{"accepts": accepts},
	}
}

// RefundResponse is a successful refund settlement. Amount is empty: the grace period may still be running.
func RefundResponse(channelID string, channel *generated.Channel, network x402.Network, transaction string) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     true,
		Payer:       channel.Payer.String(),
		Transaction: transaction,
		Network:     network,
		Extra: map[string]any{
			"channelState": snapshotChannel(channelID, channel),
		},
	}
}

// RecoveredRefundResponse is a refund replayed after the channel account is already gone.
func RecoveredRefundResponse(channelID, payer string, network x402.Network, transaction string) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:     true,
		Payer:       payer,
		Transaction: transaction,
		Network:     network,
		Extra:       map[string]any{"channelId": channelID},
	}
}

// SealResponse is a successful seal: the final voucher was applied and the sealed distribute paid the receiver.
func SealResponse(channelID, payer string, network x402.Network, transaction string, paidToReceiver, deposit, finalSettled uint64) *x402.SettleResponse {
	credit := strconv.FormatUint(paidToReceiver, 10)
	return &x402.SettleResponse{
		Success:     true,
		Payer:       payer,
		Transaction: transaction,
		Network:     network,
		Amount:      credit,
		Extra: map[string]any{
			"channelState": batchsettlement.BatchChannelState{
				ChannelID:    channelID,
				Balance:      strconv.FormatUint(deposit, 10),
				TotalClaimed: strconv.FormatUint(finalSettled, 10),
			},
			extraPaidToReceiver: credit,
		},
	}
}

// VerifyFailure is a failed verification response.
func VerifyFailure(reason, payer, message string) *x402.VerifyResponse {
	return &x402.VerifyResponse{
		IsValid:        false,
		InvalidReason:  reason,
		InvalidMessage: message,
		Payer:          payer,
	}
}

// SettleFailure is a failed settlement response.
func SettleFailure(network x402.Network, reason, payer, message string) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:      false,
		ErrorReason:  reason,
		ErrorMessage: message,
		Payer:        payer,
		Network:      network,
	}
}

// SettleFailureWithTransaction is a failed settlement that still names the broadcast.
func SettleFailureWithTransaction(network x402.Network, reason, payer, message, transaction string) *x402.SettleResponse {
	response := SettleFailure(network, reason, payer, message)
	response.Transaction = transaction
	return response
}

// SettlementPending is work that was broadcast but is not yet confirmed.
func SettlementPending(network x402.Network, payer, signature, message string) *x402.SettleResponse {
	return &x402.SettleResponse{
		Success:      false,
		ErrorReason:  x402.ErrSettlementPending,
		ErrorMessage: message,
		Payer:        payer,
		Transaction:  signature,
		Network:      network,
	}
}

// RecordPendingOrTerminal persists signature under key, then returns settlement_pending.
// A failed store write is terminal, with the signature kept for manual reconciliation.
func RecordPendingOrTerminal(
	ctx context.Context,
	store x402.PendingSettlementStore,
	key, signature, payer string,
	network x402.Network,
	cause error,
) *x402.SettleResponse {
	if err := store.Set(ctx, key, signature); err != nil {
		return SettleFailureWithTransaction(network, "transaction_failed", payer,
			fmt.Sprintf("settlement_pending, but failed to persist for retry: %s", err.Error()), signature)
	}
	message := ""
	if cause != nil {
		message = cause.Error()
	}
	return SettlementPending(network, payer, signature, message)
}

func classifyKnownError(err error) (string, bool) {
	if err == nil {
		return "", false
	}
	var onchain *svm.TransactionOnchainFailureError
	if errors.As(err, &onchain) {
		return "transaction_failed", true
	}
	message := err.Error()
	if contains(message, ChannelBusy) {
		return ChannelBusy, true
	}
	if contains(message, InvalidPaymentRequirements) {
		return InvalidPaymentRequirements, true
	}
	if strings.HasPrefix(message, svm.ErrUnsupportedTransactionVersion) {
		return svm.ErrUnsupportedTransactionVersion, true
	}
	for _, reason := range batchsettlement.ErrorReasons() {
		if contains(message, reason) {
			return reason, true
		}
	}
	return "", false
}

// ClassifyError maps an error onto the scheme's reason vocabulary, returning
// UnexpectedSettleError for an unclassified error.
func ClassifyError(err error) string {
	if reason, ok := classifyKnownError(err); ok {
		return reason
	}
	return UnexpectedSettleError
}

func contains(message, part string) bool {
	return part != "" && strings.Contains(message, part)
}

// ParseOptionalSlot parses an optional extra.recentSlot hint.
func ParseOptionalSlot(value any) (*uint64, error) {
	if value == nil {
		return nil, nil
	}
	parsed, err := paymentchannels.ParseU64(value, "extra.recentSlot")
	if err != nil {
		return nil, fmt.Errorf("%s: %w", InvalidPaymentRequirements, err)
	}
	return &parsed, nil
}

func isTransientRPCError(err error) bool {
	return err != nil && transientPattern.MatchString(err.Error())
}
