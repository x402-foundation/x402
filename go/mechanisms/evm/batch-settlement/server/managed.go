package server

import (
	"errors"
	"math/big"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

// isCorrectiveMismatch reports whether a verify rejection carries a
// resyncable cumulative baseline. The facilitator emits
// ErrCumulativeAmountMismatch for managed voucher-store drift, while the
// shared client handshake also accepts ErrCumulativeBelowClaimed (canonical
// facilitator form); the server must propagate corrective extras for both or
// the client's ProcessCorrectivePaymentRequired sees a 402 without
// channelState/voucherState and falls back to stale onchain recovery.
func isCorrectiveMismatch(reason string) bool {
	return reason == batchsettlement.ErrCumulativeAmountMismatch ||
		reason == batchsettlement.ErrCumulativeBelowClaimed
}

// handleManagedBeforeVerify is a pass-through verify: min-deposit and
// channel-id binding only. Admission stays with the facilitator.
func handleManagedBeforeVerify(s *BatchSettlementEvmScheme, ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchedPayload(raw) {
		return nil, nil
	}
	if abort := AbortIfUnexpectedServerAuthoredSettleFields(raw); abort != nil {
		return abort, nil
	}
	minDepositAbort, hintErr := AbortIfBelowMinDeposit(s, raw, ctx.Requirements)
	if hintErr != nil {
		return nil, hintErr
	}
	if minDepositAbort != nil {
		return minDepositAbort, nil
	}
	return AbortIfChannelUnbound(raw, ctx.Requirements.GetNetwork()), nil
}

// handleManagedAfterVerify stashes a channel view for refund enrichment and
// the replica, or corrective extras. Refunds skip the resource handler.
func handleManagedAfterVerify(s *BatchSettlementEvmScheme, ctx x402.VerifyResultContext) (*x402.AfterVerifyResult, error) {
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchedPayload(raw) {
		return nil, nil
	}
	if ctx.Result == nil {
		return nil, nil
	}
	if !ctx.Result.IsValid {
		if isCorrectiveMismatch(ctx.Result.InvalidReason) {
			ex := ctx.Result.Extra
			channelState := readCorrectiveChannelState(ex)
			voucherState := readCorrectiveVoucherState(ex)
			if channelState != nil || voucherState != nil {
				s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{
					CorrectiveChannelState: channelState,
					CorrectiveVoucherState: voucherState,
				})
			}
		}
		return nil, nil
	}

	ex := ctx.Result.Extra
	voucher, _ := raw["voucher"].(map[string]interface{})
	channelId, _ := voucher["channelId"].(string)
	maxClaimable, _ := voucher["maxClaimableAmount"].(string)
	signature, _ := voucher["signature"].(string)
	cfgMap, _ := raw["channelConfig"].(map[string]interface{})
	cfg, _ := batchsettlement.ChannelConfigFromMap(cfgMap)

	snapshot := &ChannelSession{
		ChannelId:               channelId,
		ChannelConfig:           cfg,
		ChargedCumulativeAmount: mapStringField(ex, "chargedCumulativeAmount", "0"),
		SignedMaxClaimable:      maxClaimable,
		Signature:               signature,
		Balance:                 mapStringField(ex, "balance", "0"),
		TotalClaimed:            mapStringField(ex, "totalClaimed", "0"),
		WithdrawRequestedAt:     mapIntField(ex, "withdrawRequestedAt", 0),
		RefundNonce:             mapIntField(ex, "refundNonce", 0),
		LastRequestTimestamp:    time.Now().UnixMilli(),
	}

	partial := BatchSettlementRequestContext{
		ChannelId:       channelId,
		ChannelSnapshot: snapshot,
	}
	if pendingId, ok := ex["pendingId"].(string); ok && pendingId != "" {
		partial.PendingId = pendingId
		partial.ReservationCommitted = reservationFlag(true)
	}
	s.MergeRequestContext(ctx.Payload, partial)

	if batchsettlement.IsRefundPayload(raw) {
		return SkipHandlerForRefund(channelId), nil
	}
	return nil, nil
}

// handleManagedEnrichPaymentRequiredResponse copies facilitator-supplied
// corrective extras onto the matching 402 accept.
func handleManagedEnrichPaymentRequiredResponse(s *BatchSettlementEvmScheme, ctx x402.PaymentRequiredContext) {
	if !isCorrectiveMismatch(ctx.Error) || ctx.PaymentPayload == nil {
		return
	}
	requestContext := s.TakeRequestContext(ctx.PaymentPayload)
	if requestContext == nil || requestContext.CorrectiveChannelState == nil || requestContext.CorrectiveVoucherState == nil {
		return
	}
	network := ctx.PaymentPayload.Accepted.Network
	for i := range ctx.Requirements {
		if ctx.Requirements[i].Scheme != batchsettlement.SchemeBatched {
			continue
		}
		if ctx.Requirements[i].Network != network {
			continue
		}
		WriteCorrectiveAcceptExtra(&ctx.Requirements[i], *requestContext.CorrectiveChannelState, *requestContext.CorrectiveVoucherState)
	}
}

func handleManagedBeforeSettle(*BatchSettlementEvmScheme, x402.SettleContext) (*x402.BeforeHookResult, error) {
	return nil, nil
}

func handleManagedEnrichSettlementResponse(*BatchSettlementEvmScheme, x402.SettleResultContext) (map[string]interface{}, error) {
	return nil, nil
}

func handleManagedVerifyFailure(*BatchSettlementEvmScheme, x402.VerifyFailureContext) (*x402.VerifyFailureHookResult, error) {
	return nil, nil
}

func handleManagedSettleFailure(*BatchSettlementEvmScheme, x402.SettleFailureContext) (*x402.SettleFailureHookResult, error) {
	return nil, nil
}

func handleManagedVerifiedPaymentCanceled(*BatchSettlementEvmScheme, x402.VerifiedPaymentCanceledContext) error {
	return nil
}

// handleManagedSettleOnCancel returns zero-amount requirements so the
// facilitator can drop the admission lock without charging, depositing, or refunding.
func handleManagedSettleOnCancel(ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	switch ctx.Reason {
	case x402.CancellationReasonHandlerFailed, x402.CancellationReasonHandlerThrew, x402.CancellationReasonAfterVerifyAborted:
	default:
		return nil, nil
	}
	if ctx.Payload == nil || !batchsettlement.IsBatchedPayload(ctx.Payload.GetPayload()) {
		return nil, nil
	}
	req := paymentRequirementsFromView(ctx.Requirements)
	req.Amount = "0"
	return &req, nil
}

// handleManagedEnrichSettlementPayload echoes verify pendingId onto settle and
// completes a managed refund. Cancel stamps cancel so the facilitator only
// releases the lock. Never sets claimAuthorizerSignature.
func handleManagedEnrichSettlementPayload(s *BatchSettlementEvmScheme, ctx x402.SettleContext) (map[string]interface{}, error) {
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchedPayload(raw) {
		return nil, nil
	}

	var pendingId string
	if rc := s.ReadRequestContext(ctx.Payload); rc != nil {
		pendingId = rc.PendingId
	}
	pendingFields := map[string]interface{}{}
	if pendingId != "" {
		pendingFields["pendingId"] = pendingId
	}

	if ctx.Phase == x402.SettlePhaseCancel {
		out := map[string]interface{}{"cancel": true}
		for k, v := range pendingFields {
			out[k] = v
		}
		return out, nil
	}

	if batchsettlement.IsRefundPayload(raw) {
		rc := s.ReadRequestContext(ctx.Payload)
		if rc == nil || rc.ChannelSnapshot == nil {
			return nil, errors.New(batchsettlement.ErrMissingChannel)
		}
		voucher, _ := raw["voucher"].(map[string]interface{})
		amount, _ := raw["amount"].(string)
		maxClaimable, _ := voucher["maxClaimableAmount"].(string)
		signature, _ := voucher["signature"].(string)
		channelId, _ := voucher["channelId"].(string)
		fields, err := BuildRefundSettlementFields(RefundSettlementFields{
			Ctx:                             ctx.Ctx,
			Channel:                         rc.ChannelSnapshot,
			ChannelConfig:                   rc.ChannelSnapshot.ChannelConfig,
			MaxClaimableAmount:              maxClaimable,
			Signature:                       signature,
			Amount:                          amount,
			ChannelId:                       channelId,
			Network:                         ctx.Requirements.GetNetwork(),
			RefundSigner:                    s.GetRefundAuthorizerSigner(),
			IncludeClaimAuthorizerSignature: false,
		})
		if err != nil {
			return nil, err
		}
		for k, v := range pendingFields {
			fields[k] = v
		}
		return fields, nil
	}

	if pendingId == "" {
		return nil, nil
	}
	return pendingFields, nil
}

// handleManagedAfterSettle upserts the replica after a successful managed
// settle. Cancel settles leave the replica watermark unchanged.
func handleManagedAfterSettle(s *BatchSettlementEvmScheme, ctx x402.SettleResultContext) error {
	if ctx.Result == nil || !ctx.Result.Success || ctx.Phase == x402.SettlePhaseCancel {
		return nil
	}
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchedPayload(raw) {
		return nil
	}

	voucher, _ := raw["voucher"].(map[string]interface{})
	channelId, _ := voucher["channelId"].(string)
	maxClaimable, _ := voucher["maxClaimableAmount"].(string)
	signature, _ := voucher["signature"].(string)
	cfgMap, _ := raw["channelConfig"].(map[string]interface{})
	cfg, _ := batchsettlement.ChannelConfigFromMap(cfgMap)

	channelState := readChannelStateFromExtra(ctx.Result.Extra)
	now := time.Now().UnixMilli()
	charged := ""
	if channelState != nil {
		charged = channelState.ChargedCumulativeAmount
	}
	if charged == "" {
		if rc := s.ReadRequestContext(ctx.Payload); rc != nil && rc.ChannelSnapshot != nil {
			charged = rc.ChannelSnapshot.ChargedCumulativeAmount
		}
	}
	if charged == "" {
		charged = "0"
	}

	if batchsettlement.IsRefundPayload(raw) {
		balance := "0"
		if channelState != nil && channelState.Balance != "" {
			balance = channelState.Balance
		}
		bal, _ := new(big.Int).SetString(balance, 10)
		chg, _ := new(big.Int).SetString(charged, 10)
		if bal == nil {
			bal = big.NewInt(0)
		}
		if chg == nil {
			chg = big.NewInt(0)
		}
		if bal.Cmp(chg) <= 0 {
			_, err := s.GetStorage().UpdateChannel(ctx.Ctx, channelId, func(current *ChannelSession) *ChannelSession {
				if current == nil {
					return current
				}
				return nil
			})
			return err
		}
	}

	_, err := s.GetStorage().UpdateChannel(ctx.Ctx, channelId, func(current *ChannelSession) *ChannelSession {
		if current != nil && !batchsettlement.IsRefundPayload(raw) {
			incoming, okIncoming := new(big.Int).SetString(charged, 10)
			stored, okStored := new(big.Int).SetString(current.ChargedCumulativeAmount, 10)
			if okIncoming && okStored && incoming.Cmp(stored) < 0 {
				return current
			}
		}
		var base *ChannelSession
		if current != nil {
			base = current
		} else if rc := s.ReadRequestContext(ctx.Payload); rc != nil {
			base = rc.ChannelSnapshot
		}
		next := ChannelSession{
			ChannelId:               channelId,
			ChannelConfig:           cfg,
			ChargedCumulativeAmount: charged,
			SignedMaxClaimable:      maxClaimable,
			Signature:               signature,
			Balance:                 "0",
			TotalClaimed:            "0",
			LastRequestTimestamp:    now,
		}
		if base != nil {
			if next.ChargedCumulativeAmount == "" {
				next.ChargedCumulativeAmount = base.ChargedCumulativeAmount
			}
			next.Balance = base.Balance
			next.TotalClaimed = base.TotalClaimed
			next.WithdrawRequestedAt = base.WithdrawRequestedAt
			next.RefundNonce = base.RefundNonce
		}
		if next.ChargedCumulativeAmount == "" {
			next.ChargedCumulativeAmount = "0"
		}
		if channelState != nil {
			if channelState.Balance != "" {
				next.Balance = channelState.Balance
			}
			if channelState.TotalClaimed != "" {
				next.TotalClaimed = channelState.TotalClaimed
			}
			next.WithdrawRequestedAt = channelState.WithdrawRequestedAt
			if channelState.RefundNonce != "" {
				if n, ok := new(big.Int).SetString(channelState.RefundNonce, 10); ok {
					next.RefundNonce = int(n.Int64())
				}
			}
		}
		return &next
	})
	return err
}

func readCorrectiveChannelState(extra map[string]interface{}) *batchsettlement.BatchSettlementChannelStateExtra {
	if extra == nil {
		return nil
	}
	raw, ok := extra["channelState"].(map[string]interface{})
	if !ok {
		return nil
	}
	out := &batchsettlement.BatchSettlementChannelStateExtra{}
	out.ChannelId, _ = raw["channelId"].(string)
	out.Balance, _ = raw["balance"].(string)
	out.TotalClaimed, _ = raw["totalClaimed"].(string)
	out.ChargedCumulativeAmount, _ = raw["chargedCumulativeAmount"].(string)
	if v, ok := raw["refundNonce"].(string); ok {
		out.RefundNonce = v
	} else if v, ok := raw["refundNonce"].(float64); ok {
		out.RefundNonce = formatInt(int(v))
	}
	switch v := raw["withdrawRequestedAt"].(type) {
	case float64:
		out.WithdrawRequestedAt = int(v)
	case int:
		out.WithdrawRequestedAt = v
	}
	return out
}

func readCorrectiveVoucherState(extra map[string]interface{}) *batchsettlement.BatchSettlementVoucherStateExtra {
	if extra == nil {
		return nil
	}
	raw, ok := extra["voucherState"].(map[string]interface{})
	if !ok {
		return nil
	}
	out := &batchsettlement.BatchSettlementVoucherStateExtra{}
	out.SignedMaxClaimable, _ = raw["signedMaxClaimable"].(string)
	out.Signature, _ = raw["signature"].(string)
	return out
}

func formatInt(n int) string {
	return big.NewInt(int64(n)).String()
}
