package server

import (
	"context"
	"fmt"
	"math/big"
	"strings"
	"time"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/types"
)

// BeforeVerifyHook detects stale cumulative amounts on voucher payloads and
// aborts with ErrCumulativeAmountMismatch so the client can resync via the
// corrective 402 response.
func (s *BatchedEvmScheme) BeforeVerifyHook() x402.BeforeVerifyHook {
	return func(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
		if ctx.Requirements.GetScheme() != batched.SchemeBatched {
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()

		var voucherFields map[string]interface{}
		isRefund := false
		switch {
		case batched.IsVoucherPayload(payload):
			voucherFields, _ = payload["voucher"].(map[string]interface{})
		case batched.IsRefundPayload(payload):
			voucherFields, _ = payload["voucher"].(map[string]interface{})
			isRefund = true
		default:
			return nil, nil
		}
		if voucherFields == nil {
			return nil, nil
		}

		channelId, _ := voucherFields["channelId"].(string)

		session, storageErr := s.storage.Get(batched.NormalizeChannelId(channelId))
		if storageErr != nil {
			return nil, nil //nolint:nilerr // storage error is non-fatal; skip stale check
		}
		// When no local session exists, verification is delegated to the facilitator
		// (which checks on-chain state); AfterVerifyHook then rebuilds the session.
		if session == nil {
			return nil, nil
		}

		prevCharged, _ := new(big.Int).SetString(session.ChargedCumulativeAmount, 10)
		if prevCharged == nil {
			prevCharged = big.NewInt(0)
		}
		reqAmount, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
		if reqAmount == nil {
			return nil, nil
		}

		// Refund vouchers are zero-charge: client signs the existing
		// chargedCumulativeAmount (no requirement.amount added).
		var expectedMaxClaimable *big.Int
		if isRefund {
			expectedMaxClaimable = new(big.Int).Set(prevCharged)
		} else {
			expectedMaxClaimable = new(big.Int).Add(prevCharged, reqAmount)
		}
		maxClaimableStr, _ := voucherFields["maxClaimableAmount"].(string)
		actualMaxClaimable, _ := new(big.Int).SetString(maxClaimableStr, 10)

		if actualMaxClaimable != nil && actualMaxClaimable.Cmp(expectedMaxClaimable) == 0 {
			return nil, nil
		}

		// Capture a payload-keyed snapshot so the resource server can echo
		// ChannelState in the corrective 402 (see EnrichRequirementsWithChannelState).
		if pp, ok := ctx.Payload.(*types.PaymentPayload); ok {
			s.RememberChannelSnapshot(pp, session)
		}

		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  batched.ErrCumulativeAmountMismatch,
			Message: "Client voucher base does not match server state",
		}, nil
	}
}

// AfterVerifyHook returns a hook that persists channel session state after
// successful verification.  It extracts channelId, voucher signature, and
// on-chain snapshot from the verify response and stores/updates the session.
//
// For refund vouchers (refund: true), additionally returns a SkipHandler
// directive so the resource server bypasses the application handler and
// settles inline.
func (s *BatchedEvmScheme) AfterVerifyHook() x402.AfterVerifyHook {
	return func(ctx x402.VerifyResultContext) (*x402.AfterVerifyResult, error) {
		if ctx.Requirements.GetScheme() != batched.SchemeBatched {
			return nil, nil
		}
		if ctx.Result == nil || !ctx.Result.IsValid || ctx.Result.Payer == "" {
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()

		var channelId, signedMaxClaimable, signature, payer string
		var channelConfig *batched.ChannelConfig
		isRefundVoucher := false

		switch {
		case batched.IsDepositPayload(payload):
			dp, parseErr := batched.DepositPayloadFromMap(payload)
			if parseErr != nil {
				return nil, nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = dp.Voucher.ChannelId
			signedMaxClaimable = dp.Voucher.MaxClaimableAmount
			signature = dp.Voucher.Signature
			cfg := dp.ChannelConfig
			channelConfig = &cfg
			payer = cfg.Payer
		case batched.IsVoucherPayload(payload):
			vp, parseErr := batched.VoucherPayloadFromMap(payload)
			if parseErr != nil {
				return nil, nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = vp.Voucher.ChannelId
			signedMaxClaimable = vp.Voucher.MaxClaimableAmount
			signature = vp.Voucher.Signature
			cfg := vp.ChannelConfig
			channelConfig = &cfg
			payer = cfg.Payer
		case batched.IsRefundPayload(payload):
			rp, parseErr := batched.RefundPayloadFromMap(payload)
			if parseErr != nil {
				return nil, nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = rp.Voucher.ChannelId
			signedMaxClaimable = rp.Voucher.MaxClaimableAmount
			signature = rp.Voucher.Signature
			cfg := rp.ChannelConfig
			channelConfig = &cfg
			payer = cfg.Payer
			isRefundVoucher = true
		default:
			return nil, nil
		}

		if payer == "" {
			payer = ctx.Result.Payer
		}

		ex := ctx.Result.Extra
		balance := mapStringField(ex, "balance", "0")
		totalClaimed := mapStringField(ex, "totalClaimed", "0")
		withdrawRequestedAt := mapIntField(ex, "withdrawRequestedAt", 0)
		refundNonce := mapIntField(ex, "refundNonce", 0)

		normalizedId := batched.NormalizeChannelId(channelId)
		prev, _ := s.storage.Get(normalizedId)

		resolvedConfig := channelConfig
		if resolvedConfig == nil && prev != nil {
			resolvedConfig = &prev.ChannelConfig
		}
		if resolvedConfig == nil {
			return nil, nil
		}

		prevCharged := totalClaimed
		if prev != nil {
			prevCharged = prev.ChargedCumulativeAmount
		}

		session := &ChannelSession{
			ChannelId:               normalizedId,
			ChannelConfig:           *resolvedConfig,
			Payer:                   strings.ToLower(payer),
			ChargedCumulativeAmount: prevCharged,
			SignedMaxClaimable:      signedMaxClaimable,
			Signature:               signature,
			Balance:                 balance,
			TotalClaimed:            totalClaimed,
			WithdrawRequestedAt:     withdrawRequestedAt,
			RefundNonce:             refundNonce,
			LastRequestTimestamp:    time.Now().UnixMilli(),
		}

		if err := s.storage.Set(normalizedId, session); err != nil {
			return nil, err
		}

		if isRefundVoucher {
			return &x402.AfterVerifyResult{
				SkipHandler: true,
				Response: &x402.SkipHandlerDirective{
					ContentType: "application/json",
					Body: map[string]interface{}{
						"message":   "Refund acknowledged",
						"channelId": normalizedId,
					},
				},
			}, nil
		}
		return nil, nil
	}
}

// BeforeSettleHook returns a hook that implements the core batched settlement
// logic.  For voucher payloads it:
//   - Increments chargedCumulativeAmount locally using CompareAndSet
//   - Returns a Skip result so on-chain settlement is NOT triggered
//   - If the voucher has refund=true, rewrites the payload to a refund settle
//     action that the facilitator will execute on-chain
//
// For deposit payloads it annotates responseExtra with the new charged amount.
// All other payload types pass through to the facilitator.
func (s *BatchedEvmScheme) BeforeSettleHook() x402.BeforeSettleHook {
	return func(ctx x402.SettleContext) (*x402.BeforeHookResult, error) {
		if ctx.Requirements.GetScheme() != batched.SchemeBatched {
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()

		// --- Deposit path: annotate responseExtra ---
		if batched.IsDepositPayload(payload) {
			channelId := ""
			if v, ok := payload["voucher"].(map[string]interface{}); ok {
				channelId, _ = v["channelId"].(string)
			}
			normalizedId := batched.NormalizeChannelId(channelId)
			session, _ := s.storage.Get(normalizedId)
			prevCharged := big.NewInt(0)
			if session != nil {
				if pc, ok := new(big.Int).SetString(session.ChargedCumulativeAmount, 10); ok {
					prevCharged = pc
				}
			}
			reqAmount, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
			if reqAmount == nil {
				reqAmount = big.NewInt(0)
			}
			newCharged := new(big.Int).Add(prevCharged, reqAmount)
			payload["responseExtra"] = map[string]interface{}{
				"chargedCumulativeAmount": newCharged.String(),
			}
			return nil, nil
		}

		// --- Refund path: cooperative-refund rewrite ---
		if batched.IsRefundPayload(payload) {
			voucherMap, _ := payload["voucher"].(map[string]interface{})
			if voucherMap == nil {
				return nil, nil
			}
			channelId, _ := voucherMap["channelId"].(string)
			normalizedId := batched.NormalizeChannelId(channelId)
			session, storageErr := s.storage.Get(normalizedId)
			if storageErr != nil || session == nil {
				return &x402.BeforeHookResult{ //nolint:nilerr
					Abort:   true,
					Reason:  "missing_batched_session",
					Message: "No session for channel; verify may not have completed",
				}, nil
			}
			return s.handleRefundRewrite(ctx, session, payload)
		}

		// --- Voucher path: skip on-chain settlement ---
		if !batched.IsVoucherPayload(payload) {
			return nil, nil
		}

		voucherMap, _ := payload["voucher"].(map[string]interface{})
		if voucherMap == nil {
			return nil, nil
		}
		channelId, _ := voucherMap["channelId"].(string)
		normalizedId := batched.NormalizeChannelId(channelId)

		session, storageErr := s.storage.Get(normalizedId)
		if storageErr != nil || session == nil {
			return &x402.BeforeHookResult{ //nolint:nilerr // storage error treated as missing session
				Abort:   true,
				Reason:  "missing_batched_session",
				Message: "No session for channel; verify may not have completed",
			}, nil
		}

		increment, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
		if increment == nil {
			increment = big.NewInt(0)
		}
		maxClaimableStr, _ := voucherMap["maxClaimableAmount"].(string)
		signedCap, _ := new(big.Int).SetString(maxClaimableStr, 10)
		prevCharged, _ := new(big.Int).SetString(session.ChargedCumulativeAmount, 10)
		if prevCharged == nil {
			prevCharged = big.NewInt(0)
		}
		newCharged := new(big.Int).Add(prevCharged, increment)

		if signedCap != nil && newCharged.Cmp(signedCap) > 0 {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  "batched_charge_exceeds_signed_cumulative",
				Message: fmt.Sprintf("Charged %s exceeds signed max %s", newCharged.String(), signedCap.String()),
			}, nil
		}

		// Normal voucher: CAS update session and skip settlement
		maxClaimable := maxClaimableStr
		sig, _ := voucherMap["signature"].(string)

		updatedSession := &ChannelSession{
			ChannelId:               normalizedId,
			ChannelConfig:           session.ChannelConfig,
			Payer:                   session.Payer,
			ChargedCumulativeAmount: newCharged.String(),
			SignedMaxClaimable:      maxClaimable,
			Signature:               sig,
			Balance:                 session.Balance,
			TotalClaimed:            session.TotalClaimed,
			WithdrawRequestedAt:     session.WithdrawRequestedAt,
			RefundNonce:             session.RefundNonce,
			LastRequestTimestamp:    time.Now().UnixMilli(),
		}

		swapped, err := s.storage.CompareAndSet(normalizedId, session.ChargedCumulativeAmount, updatedSession)
		if err != nil {
			return nil, err
		}
		if !swapped {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  "batched_channel_busy",
				Message: "Concurrent request modified channel state",
			}, nil
		}

		return &x402.BeforeHookResult{
			Skip: true,
			SkipResult: &x402.SettleResponse{
				Success:     true,
				Transaction: "",
				Network:     x402.Network(ctx.Requirements.GetNetwork()),
				Payer:       session.Payer,
				Amount:      ctx.Requirements.GetAmount(),
				Extra: map[string]interface{}{
					"channelId":               normalizedId,
					"chargedCumulativeAmount": newCharged.String(),
					"balance":                 session.Balance,
					"totalClaimed":            session.TotalClaimed,
					"withdrawRequestedAt":     session.WithdrawRequestedAt,
					"refundNonce":             fmt.Sprintf("%d", session.RefundNonce),
				},
			},
		}, nil
	}
}

// handleRefundRewrite rewrites a refund-flagged (zero-charge) voucher into a
// refundWithSignature settle-action payload for the facilitator to execute
// on-chain. Supports an optional partial refundAmount in the voucher; otherwise
// drains the channel's full remainder.
func (s *BatchedEvmScheme) handleRefundRewrite(
	ctx x402.SettleContext,
	session *ChannelSession,
	payload map[string]interface{},
) (*x402.BeforeHookResult, error) {
	config := session.ChannelConfig
	voucherMap, _ := payload["voucher"].(map[string]interface{})
	if voucherMap == nil {
		voucherMap = map[string]interface{}{}
	}
	maxClaimable, _ := voucherMap["maxClaimableAmount"].(string)
	sig, _ := voucherMap["signature"].(string)

	// Refund vouchers are zero-charge: claim's totalClaimed == session.chargedCumulativeAmount.
	claimEntry := batched.BatchedVoucherClaim{
		Voucher: struct {
			Channel            batched.ChannelConfig `json:"channel"`
			MaxClaimableAmount string                `json:"maxClaimableAmount"`
		}{
			Channel:            config,
			MaxClaimableAmount: maxClaimable,
		},
		Signature:    sig,
		TotalClaimed: session.ChargedCumulativeAmount,
	}

	balance, _ := new(big.Int).SetString(session.Balance, 10)
	if balance == nil {
		balance = big.NewInt(0)
	}
	charged, _ := new(big.Int).SetString(session.ChargedCumulativeAmount, 10)
	if charged == nil {
		charged = big.NewInt(0)
	}
	remainder := new(big.Int).Sub(balance, charged)
	if remainder.Sign() <= 0 {
		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  "batch_settlement_refund_no_balance",
			Message: "Channel has no remaining balance to refund",
		}, nil
	}

	refundAmount := new(big.Int).Set(remainder)
	if requestedStr, ok := payload["amount"].(string); ok && requestedStr != "" {
		requested, ok := new(big.Int).SetString(requestedStr, 10)
		if !ok || requested.Sign() <= 0 {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  "batch_settlement_refund_amount_invalid",
				Message: "refundAmount must be a positive integer",
			}, nil
		}
		if requested.Cmp(remainder) > 0 {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  "batch_settlement_refund_amount_exceeds_balance",
				Message: fmt.Sprintf("refundAmount %s exceeds remainder %s", requested.String(), remainder.String()),
			}, nil
		}
		refundAmount = requested
	}

	normalizedId := batched.NormalizeChannelId(session.ChannelId)

	nonce := fmt.Sprintf("%d", session.RefundNonce)

	// Build the new wire-shape voucher (channelId / maxClaimableAmount / signature).
	voucherFields := batched.BatchedVoucherFields{
		ChannelId:          normalizedId,
		MaxClaimableAmount: maxClaimable,
		Signature:          sig,
	}

	refundPayload := &batched.BatchedEnrichedRefundPayload{
		Type:          "refund",
		ChannelConfig: config,
		Voucher:       voucherFields,
		Amount:        refundAmount.String(),
		RefundNonce:   nonce,
		Claims:        []batched.BatchedVoucherClaim{claimEntry},
	}

	if s.receiverAuthorizerSigner != nil {
		network := ctx.Requirements.GetNetwork()

		authSig, err := s.SignRefund(context.Background(), normalizedId, refundAmount.String(), nonce, network)
		if err != nil {
			return nil, fmt.Errorf("failed to sign refund: %w", err)
		}

		claimAuthSig, err := s.SignClaimBatch(context.Background(), []batched.BatchedVoucherClaim{claimEntry}, network)
		if err != nil {
			return nil, fmt.Errorf("failed to sign claim batch for refund: %w", err)
		}

		refundPayload.RefundAuthorizerSignature = evm.BytesToHex(authSig)
		refundPayload.ClaimAuthorizerSignature = evm.BytesToHex(claimAuthSig)
	}

	// Rewrite the payload in place so the caller's pointer stays valid.
	for k := range payload {
		delete(payload, k)
	}
	for k, v := range refundPayload.ToMap() {
		payload[k] = v
	}

	return nil, nil // Let the facilitator handle the rewritten refund payload
}

// AfterSettleHook returns a hook that updates session state after settlement.
// For deposits: updates balance. For refunds: deletes the session on full
// refund or updates balance/refundNonce on partial refund.
func (s *BatchedEvmScheme) AfterSettleHook() x402.AfterSettleHook {
	return func(ctx x402.SettleResultContext) error {
		if ctx.Requirements.GetScheme() != batched.SchemeBatched {
			return nil
		}
		if ctx.Result == nil || !ctx.Result.Success {
			return nil
		}

		payload := ctx.Payload.GetPayload()

		// After deposit: update session balance from response
		if batched.IsDepositPayload(payload) {
			if ctx.Result.Extra != nil {
				channelId := mapStringField(ctx.Result.Extra, "channelId", "")
				if channelId == "" {
					return nil
				}
				normalizedId := batched.NormalizeChannelId(channelId)
				session, getErr := s.storage.Get(normalizedId)
				if getErr != nil || session == nil {
					return nil //nolint:nilerr // storage error in after-hook is non-fatal
				}
				session.Balance = mapStringField(ctx.Result.Extra, "balance", session.Balance)
				session.TotalClaimed = mapStringField(ctx.Result.Extra, "totalClaimed", session.TotalClaimed)

				// Update charged from responseExtra if present
				if responseExtra, ok := payload["responseExtra"].(map[string]interface{}); ok {
					if charged, ok := responseExtra["chargedCumulativeAmount"].(string); ok {
						session.ChargedCumulativeAmount = charged
					}
				}

				return s.storage.Set(normalizedId, session)
			}
			return nil
		}

		// After refund: reconcile session — delete on full refund (remainder<=0),
		// otherwise update balance and bump refundNonce.
		if batched.IsEnrichedRefundPayload(payload) {
			refundPayload, err := batched.EnrichedRefundPayloadFromMap(payload)
			if err != nil {
				return nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId, err := batched.ComputeChannelId(refundPayload.ChannelConfig, ctx.Requirements.GetNetwork())
			if err != nil {
				return nil //nolint:nilerr
			}
			normalizedId := batched.NormalizeChannelId(channelId)
			prevSession, _ := s.storage.Get(normalizedId)

			var fallback *batched.BatchedPaymentResponseExtra
			if prevSession != nil {
				amountBig, _ := new(big.Int).SetString(refundPayload.Amount, 10)
				if amountBig == nil {
					amountBig = big.NewInt(0)
				}
				fallback = buildRefundResponseSnapshot(prevSession, normalizedId, amountBig)
			}
			if fallback == nil {
				fallback = &batched.BatchedPaymentResponseExtra{
					ChannelId:   normalizedId,
					Balance:     "0",
					RefundNonce: "0",
				}
			}

			extra := ctx.Result.Extra
			refundedAmount := refundPayload.Amount

			ctx.Result.Extra = map[string]interface{}{
				"channelId":               mapStringField(extra, "channelId", fallback.ChannelId),
				"chargedCumulativeAmount": mapStringField(extra, "chargedCumulativeAmount", fallback.ChargedCumulativeAmount),
				"balance":                 mapStringField(extra, "balance", fallback.Balance),
				"totalClaimed":            mapStringField(extra, "totalClaimed", fallback.TotalClaimed),
				"withdrawRequestedAt":     mapIntField(extra, "withdrawRequestedAt", fallback.WithdrawRequestedAt),
				"refundNonce":             mapStringField(extra, "refundNonce", fallback.RefundNonce),
			}

			refundedBig, _ := new(big.Int).SetString(refundedAmount, 10)
			if refundedBig == nil {
				refundedBig = big.NewInt(0)
			}

			if prevSession == nil {
				return nil
			}

			prevBalance, _ := new(big.Int).SetString(prevSession.Balance, 10)
			if prevBalance == nil {
				prevBalance = big.NewInt(0)
			}
			prevCharged, _ := new(big.Int).SetString(prevSession.ChargedCumulativeAmount, 10)
			if prevCharged == nil {
				prevCharged = big.NewInt(0)
			}
			remainderAfter := new(big.Int).Sub(prevBalance, prevCharged)
			remainderAfter.Sub(remainderAfter, refundedBig)

			if remainderAfter.Sign() <= 0 {
				return s.storage.Delete(normalizedId)
			}

			prevSession.Balance = new(big.Int).Sub(prevBalance, refundedBig).String()
			prevSession.RefundNonce++
			prevSession.LastRequestTimestamp = time.Now().UnixMilli()
			return s.storage.Set(normalizedId, prevSession)
		}

		return nil
	}
}

// buildRefundResponseSnapshot mirrors the TS helper of the same name: it builds
// the BatchedPaymentResponseExtra describing channel state immediately after a
// cooperative refund of `refundAmount` is applied to `session`.
func buildRefundResponseSnapshot(session *ChannelSession, channelId string, refundAmount *big.Int) *batched.BatchedPaymentResponseExtra {
	balance, _ := new(big.Int).SetString(session.Balance, 10)
	if balance == nil {
		balance = big.NewInt(0)
	}
	postBalance := new(big.Int).Sub(balance, refundAmount)
	if postBalance.Sign() < 0 {
		postBalance = big.NewInt(0)
	}
	finalClaimed := session.ChargedCumulativeAmount
	totalClaimed := finalClaimed
	if session.TotalClaimed != "" {
		totalClaimed = finalClaimed
	}
	return &batched.BatchedPaymentResponseExtra{
		ChannelId:               channelId,
		ChargedCumulativeAmount: finalClaimed,
		Balance:                 postBalance.String(),
		TotalClaimed:            totalClaimed,
		WithdrawRequestedAt:     0,
		RefundNonce:             fmt.Sprintf("%d", session.RefundNonce+1),
	}
}

// mapStringField extracts a string field from a map with a default.
func mapStringField(m map[string]interface{}, key string, defaultVal string) string {
	if m == nil {
		return defaultVal
	}
	if v, ok := m[key].(string); ok {
		return v
	}
	if v, ok := m[key].(float64); ok {
		return fmt.Sprintf("%.0f", v)
	}
	return defaultVal
}

// mapIntField extracts an int field from a map with a default.
func mapIntField(m map[string]interface{}, key string, defaultVal int) int {
	if m == nil {
		return defaultVal
	}
	switch v := m[key].(type) {
	case float64:
		return int(v)
	case int:
		return v
	case string:
		n, _ := new(big.Int).SetString(v, 10)
		if n != nil {
			return int(n.Int64())
		}
	}
	return defaultVal
}
