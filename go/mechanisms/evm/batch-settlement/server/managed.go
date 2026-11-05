package server

import (
	"errors"
	"log"
	"math/big"
	"strconv"
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
				}, requestContextTtl(ctx.Requirements.GetMaxTimeoutSeconds()))
			}
		}
		return nil, nil
	}

	ex := ctx.Result.Extra
	voucher, _ := raw["voucher"].(map[string]interface{})
	channelId, _ := voucher["channelId"].(string)

	pendingId, _ := ex["pendingId"].(string)
	if pendingId == "" {
		return verificationStateUnavailableAfter(), nil
	}
	s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{
		ChannelId:            channelId,
		PendingId:            pendingId,
		ReservationCommitted: reservationFlag(true),
	}, requestContextTtl(ctx.Requirements.GetMaxTimeoutSeconds()))

	state, ok := parseManagedChannelState(ex)
	if !ok {
		return verificationStateUnavailableAfter(), nil
	}
	snapshot := toChannelView(raw, state)
	s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{ChannelSnapshot: &snapshot})

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

func handleManagedSettleFailure(s *BatchSettlementEvmScheme, ctx x402.SettleFailureContext) (*x402.SettleFailureHookResult, error) {
	s.TakeRequestContext(ctx.Payload)
	return nil, nil
}

func handleManagedVerifiedPaymentCanceled(*BatchSettlementEvmScheme, x402.VerifiedPaymentCanceledContext) error {
	return nil
}

// handleManagedSettleOnCancel returns zero-amount requirements so the
// facilitator can drop the admission lock without charging, depositing, or refunding.
func handleManagedSettleOnCancel(s *BatchSettlementEvmScheme, ctx x402.VerifiedPaymentCanceledContext) (*types.PaymentRequirements, error) {
	switch ctx.Reason {
	case x402.CancellationReasonHandlerFailed,
		x402.CancellationReasonHandlerThrew,
		x402.CancellationReasonAfterVerifyAborted,
		x402.CancellationReasonSettlementPreflightFailed:
	default:
		return nil, nil
	}
	if ctx.Payload == nil || !batchsettlement.IsBatchedPayload(ctx.Payload.GetPayload()) {
		return nil, nil
	}
	if rc := s.ReadRequestContext(ctx.Payload); rc == nil || rc.PendingId == "" {
		var verifiedPendingId string
		if ctx.VerifyResult != nil {
			verifiedPendingId, _ = ctx.VerifyResult.Extra["pendingId"].(string)
		}
		if verifiedPendingId == "" {
			s.TakeRequestContext(ctx.Payload)
			return nil, nil
		}
		s.MergeRequestContext(
			ctx.Payload,
			BatchSettlementRequestContext{PendingId: verifiedPendingId},
			requestContextTtl(ctx.Requirements.GetMaxTimeoutSeconds()),
		)
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

	rc := s.ReadRequestContext(ctx.Payload)
	var pendingId string
	if rc != nil {
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
// settle. Cancel settles leave the replica watermark unchanged. Every managed
// settle is terminal, so the request context is dropped on all paths.
func handleManagedAfterSettle(s *BatchSettlementEvmScheme, ctx x402.SettleResultContext) error {
	defer s.TakeRequestContext(ctx.Payload)
	if ctx.Result == nil || !ctx.Result.Success || ctx.Phase == x402.SettlePhaseCancel {
		return nil
	}
	raw := ctx.Payload.GetPayload()
	if !batchsettlement.IsBatchedPayload(raw) {
		return nil
	}

	voucher, _ := raw["voucher"].(map[string]interface{})
	channelId, _ := voucher["channelId"].(string)
	isRefund := batchsettlement.IsRefundPayload(raw)

	replicaState, ok := managedReplicaState(s, ctx, isRefund)
	if !ok {
		log.Printf("[batched] managed afterSettle: no valid channel state for channel %s; replica left unchanged", channelId)
		return nil
	}

	state := toChannelView(raw, replicaState)
	if isRefund && bigOrZero(state.Balance).Cmp(bigOrZero(state.ChargedCumulativeAmount)) <= 0 {
		_, err := s.GetStorage().UpdateChannel(ctx.Ctx, channelId, func(*ChannelSession) *ChannelSession {
			return nil
		})
		return err
	}

	_, err := s.GetStorage().UpdateChannel(ctx.Ctx, channelId, func(current *ChannelSession) *ChannelSession {
		if current != nil && !isRefund {
			incoming, okIncoming := new(big.Int).SetString(state.ChargedCumulativeAmount, 10)
			stored, okStored := new(big.Int).SetString(current.ChargedCumulativeAmount, 10)
			if okIncoming && okStored && incoming.Cmp(stored) < 0 {
				return current
			}
		}
		next := state
		return &next
	})
	return err
}

func toChannelView(raw map[string]interface{}, state ChannelSession) ChannelSession {
	voucher, _ := raw["voucher"].(map[string]interface{})
	cfgMap, _ := raw["channelConfig"].(map[string]interface{})
	state.ChannelId, _ = voucher["channelId"].(string)
	state.ChannelConfig, _ = batchsettlement.ChannelConfigFromMap(cfgMap)
	state.SignedMaxClaimable, _ = voucher["maxClaimableAmount"].(string)
	state.Signature, _ = voucher["signature"].(string)
	state.LastRequestTimestamp = time.Now().UnixMilli()
	return state
}

func managedReplicaState(s *BatchSettlementEvmScheme, ctx x402.SettleResultContext, isRefund bool) (ChannelSession, bool) {
	if raw, ok := ctx.Result.Extra["channelState"].(map[string]interface{}); ok {
		if state, ok := parseManagedChannelState(raw); ok {
			return state, true
		}
	}
	if isRefund {
		return ChannelSession{}, false
	}
	rc := s.ReadRequestContext(ctx.Payload)
	if rc == nil || rc.ChannelSnapshot == nil {
		return ChannelSession{}, false
	}
	return *rc.ChannelSnapshot, true
}

func parseManagedChannelState(m map[string]interface{}) (ChannelSession, bool) {
	charged, okCharged := mapUintStringField(m, "chargedCumulativeAmount")
	balance, okBalance := mapUintStringField(m, "balance")
	totalClaimed, okClaimed := mapUintStringField(m, "totalClaimed")
	refundNonce, okNonce := mapUintIntField(m, "refundNonce")
	withdrawRequestedAt, okWithdraw := mapUintIntField(m, "withdrawRequestedAt")
	if !okCharged || !okBalance || !okClaimed || !okNonce || !okWithdraw {
		return ChannelSession{}, false
	}
	return ChannelSession{
		ChargedCumulativeAmount: charged,
		Balance:                 balance,
		TotalClaimed:            totalClaimed,
		RefundNonce:             refundNonce,
		WithdrawRequestedAt:     withdrawRequestedAt,
	}, true
}

func mapUintIntField(m map[string]interface{}, key string) (int, bool) {
	if n, ok := m[key].(int); ok {
		return n, n >= 0
	}
	s, ok := mapUintStringField(m, key)
	if !ok {
		return 0, false
	}
	n, err := strconv.Atoi(s)
	return n, err == nil
}

func readCorrectiveChannelState(extra map[string]interface{}) *batchsettlement.BatchSettlementChannelStateExtra {
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
		out.RefundNonce = strconv.Itoa(int(v))
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
	raw, ok := extra["voucherState"].(map[string]interface{})
	if !ok {
		return nil
	}
	out := &batchsettlement.BatchSettlementVoucherStateExtra{}
	out.SignedMaxClaimable, _ = raw["signedMaxClaimable"].(string)
	out.Signature, _ = raw["signature"].(string)
	return out
}
