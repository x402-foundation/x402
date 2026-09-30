package facilitator

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels/generated"
)

var (
	statusCodePattern = regexp.MustCompile(`\b429\b|\b503\b`)
	transientPattern  = regexp.MustCompile(`(?i)\b429\b|\b503\b|too many requests`)
)

// PendingSignatureOf returns the signature carried by an error that means the
// broadcast's outcome is unknown.
func PendingSignatureOf(err error) (string, bool) {
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

func snapshotChannel(channelID string, channel *generated.Channel, charged *uint64) batchsettlement.BatchChannelState {
	snapshot := batchsettlement.BatchChannelState{
		ChannelID:    channelID,
		Balance:      strconv.FormatUint(channel.Deposit, 10),
		TotalClaimed: strconv.FormatUint(channel.Settlement.Settled, 10),
	}
	if generated.ChannelStatus(channel.Status) == generated.ChannelStatus_Closing {
		snapshot.WithdrawRequestedAt = channel.ClosureStartedAt
	}
	if charged != nil {
		snapshot.ChargedCumulativeAmount = strconv.FormatUint(*charged, 10)
	}
	return snapshot
}

// VerifiedChannelExtra projects a channel onto the flat verify response extra.
func VerifiedChannelExtra(channelID string, channel *generated.Channel) map[string]any {
	snapshot := snapshotChannel(channelID, channel, nil)
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
			"channelState": snapshotChannel(channelID, channel, nil),
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
			"channelState": snapshotChannel(channelID, channel, nil),
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
	return &x402.SettleResponse{
		Success:     true,
		Payer:       payer,
		Transaction: transaction,
		Network:     network,
		Amount:      strconv.FormatUint(paidToReceiver, 10),
		Extra: map[string]any{
			"channelState": batchsettlement.BatchChannelState{
				ChannelID:    channelID,
				Balance:      strconv.FormatUint(deposit, 10),
				TotalClaimed: strconv.FormatUint(finalSettled, 10),
			},
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
	store PendingSettlementStore,
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

// ClassifyError maps an error onto the scheme's reason vocabulary.
func ClassifyError(err error) string {
	if err == nil {
		return "transaction_failed"
	}
	message := err.Error()
	if contains(message, ChannelBusy) {
		return ChannelBusy
	}
	if statusCodePattern.MatchString(message) {
		return batchsettlement.ErrChannelState
	}
	for _, reason := range batchsettlement.ErrorReasons() {
		if contains(message, reason) {
			return reason
		}
	}
	return "transaction_failed"
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
		return nil, err
	}
	return &parsed, nil
}

func isTransientRPCError(err error) bool {
	return err != nil && transientPattern.MatchString(err.Error())
}
