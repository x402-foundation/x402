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
)

// BeforeVerifyHook returns a hook that detects stale cumulative amounts on
// voucher payloads.  If the client's maxClaimableAmount doesn't match the
// expected next value (server-tracked charged + requirement amount), the hook
// aborts with "batch_settlement_stale_cumulative_amount" so the client can
// resync via the corrective 402 response.
func (s *BatchedEvmScheme) BeforeVerifyHook() x402.BeforeVerifyHook {
	return func(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
		if ctx.Requirements.GetScheme() != batched.SchemeBatched {
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()
		if !batched.IsVoucherPayload(payload) {
			return nil, nil
		}

		channelId, _ := payload["channelId"].(string)
		session, storageErr := s.storage.Get(batched.NormalizeChannelId(channelId))
		if storageErr != nil || session == nil {
			return nil, nil //nolint:nilerr // storage error is non-fatal; skip stale check
		}

		prevCharged, _ := new(big.Int).SetString(session.ChargedCumulativeAmount, 10)
		if prevCharged == nil {
			prevCharged = big.NewInt(0)
		}
		reqAmount, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
		if reqAmount == nil {
			return nil, nil
		}

		expectedMaxClaimable := new(big.Int).Add(prevCharged, reqAmount)
		actualMaxClaimable, _ := new(big.Int).SetString(payload["maxClaimableAmount"].(string), 10)

		if actualMaxClaimable != nil && actualMaxClaimable.Cmp(expectedMaxClaimable) == 0 {
			return nil, nil
		}

		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  "batch_settlement_stale_cumulative_amount",
			Message: "Client voucher base does not match server state",
		}, nil
	}
}

// AfterVerifyHook returns a hook that persists channel session state after
// successful verification.  It extracts channelId, voucher signature, and
// on-chain snapshot from the verify response and stores/updates the session.
func (s *BatchedEvmScheme) AfterVerifyHook() x402.AfterVerifyHook {
	return func(ctx x402.VerifyResultContext) error {
		if ctx.Requirements.GetScheme() != batched.SchemeBatched {
			return nil
		}
		if ctx.Result == nil || !ctx.Result.IsValid || ctx.Result.Payer == "" {
			return nil
		}

		payload := ctx.Payload.GetPayload()

		var channelId, signedMaxClaimable, signature, payer string
		var channelConfig *batched.ChannelConfig

		switch {
		case batched.IsDepositPayload(payload):
			dp, parseErr := batched.DepositPayloadFromMap(payload)
			if parseErr != nil {
				return nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = dp.Voucher.ChannelId
			signedMaxClaimable = dp.Voucher.MaxClaimableAmount
			signature = dp.Voucher.Signature
			cfg := dp.Deposit.ChannelConfig
			channelConfig = &cfg
			payer = cfg.Payer
		case batched.IsVoucherPayload(payload):
			vp, parseErr := batched.VoucherPayloadFromMap(payload)
			if parseErr != nil {
				return nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = vp.ChannelId
			signedMaxClaimable = vp.MaxClaimableAmount
			signature = vp.Signature
			cfg := vp.ChannelConfig
			channelConfig = &cfg
			payer = cfg.Payer
		default:
			return nil
		}

		if payer == "" {
			payer = ctx.Result.Payer
		}

		ex := ctx.Result.Extensions
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
			return nil
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

		return s.storage.Set(normalizedId, session)
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

		// --- Voucher path: skip on-chain settlement ---
		if !batched.IsVoucherPayload(payload) {
			return nil, nil
		}

		channelId, _ := payload["channelId"].(string)
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
		signedCap, _ := new(big.Int).SetString(payload["maxClaimableAmount"].(string), 10)
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

		// Check for cooperative refund flag
		refund, _ := payload["refund"].(bool)
		if refund {
			return s.handleRefundRewrite(ctx, session, newCharged, payload)
		}

		// Normal voucher: CAS update session and skip settlement
		maxClaimable, _ := payload["maxClaimableAmount"].(string)
		sig, _ := payload["signature"].(string)

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
				Extensions: map[string]interface{}{
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

// handleRefundRewrite rewrites a refund-flagged voucher into a refund settle
// action payload for the facilitator to execute on-chain.
func (s *BatchedEvmScheme) handleRefundRewrite(
	ctx x402.SettleContext,
	session *ChannelSession,
	newCharged *big.Int,
	payload map[string]interface{},
) (*x402.BeforeHookResult, error) {
	config := session.ChannelConfig
	maxClaimable, _ := payload["maxClaimableAmount"].(string)
	sig, _ := payload["signature"].(string)

	claimEntry := batched.BatchedVoucherClaim{
		Voucher: struct {
			Channel            batched.ChannelConfig `json:"channel"`
			MaxClaimableAmount string                `json:"maxClaimableAmount"`
		}{
			Channel:            config,
			MaxClaimableAmount: maxClaimable,
		},
		Signature:    sig,
		TotalClaimed: newCharged.String(),
	}

	balance, _ := new(big.Int).SetString(session.Balance, 10)
	if balance == nil {
		balance = big.NewInt(0)
	}
	refundAmount := new(big.Int).Sub(balance, newCharged)
	if refundAmount.Sign() < 0 {
		refundAmount = big.NewInt(0)
	}

	normalizedId := batched.NormalizeChannelId(session.ChannelId)

	if s.receiverAuthorizerSigner != nil {
		nonce := fmt.Sprintf("%d", session.RefundNonce)
		network := ctx.Requirements.GetNetwork()

		authSig, err := s.SignRefund(context.Background(), normalizedId, refundAmount.String(), nonce, network)
		if err != nil {
			return nil, fmt.Errorf("failed to sign refund: %w", err)
		}

		claimAuthSig, err := s.SignClaimBatch(context.Background(), []batched.BatchedVoucherClaim{claimEntry}, network)
		if err != nil {
			return nil, fmt.Errorf("failed to sign claim batch for refund: %w", err)
		}

		refundPayload := &batched.BatchedRefundWithSignaturePayload{
			SettleAction:              "refundWithSignature",
			Config:                    config,
			Amount:                    refundAmount.String(),
			Nonce:                     nonce,
			Claims:                    []batched.BatchedVoucherClaim{claimEntry},
			RefundAuthorizerSignature: evm.BytesToHex(authSig),
			ClaimAuthorizerSignature:  evm.BytesToHex(claimAuthSig),
			ResponseExtra: &batched.BatchedPaymentResponseExtra{
				ChannelId:               normalizedId,
				ChargedCumulativeAmount: newCharged.String(),
				Balance:                 session.Balance,
				TotalClaimed:            session.TotalClaimed,
				WithdrawRequestedAt:     session.WithdrawRequestedAt,
				RefundNonce:             nonce,
				Refund:                  true,
			},
		}

		// Rewrite the payload to the refund settle action.
		// Clear and repopulate the existing map so the pointer the caller
		// holds remains valid.
		for k := range payload {
			delete(payload, k)
		}
		payload["settleAction"] = refundPayload.SettleAction
		payload["config"] = batched.ChannelConfigToMap(refundPayload.Config)
		payload["amount"] = refundPayload.Amount
		payload["nonce"] = refundPayload.Nonce
		payload["claims"] = batched.VoucherClaimsToList(refundPayload.Claims)
		payload["refundAuthorizerSignature"] = refundPayload.RefundAuthorizerSignature
		payload["claimAuthorizerSignature"] = refundPayload.ClaimAuthorizerSignature
		payload["responseExtra"] = refundPayload.ResponseExtra.ToMap()
	} else {
		// No receiverAuthorizerSigner — create payload without pre-signed signatures.
		// The facilitator will auto-sign using its own AuthorizerSigner.
		nonce := fmt.Sprintf("%d", session.RefundNonce)
		refundPayload := &batched.BatchedRefundWithSignaturePayload{
			SettleAction: "refundWithSignature",
			Config:       config,
			Amount:       refundAmount.String(),
			Nonce:        nonce,
			Claims:       []batched.BatchedVoucherClaim{claimEntry},
			ResponseExtra: &batched.BatchedPaymentResponseExtra{
				ChannelId:               normalizedId,
				ChargedCumulativeAmount: newCharged.String(),
				Balance:                 session.Balance,
				TotalClaimed:            session.TotalClaimed,
				WithdrawRequestedAt:     session.WithdrawRequestedAt,
				RefundNonce:             nonce,
				Refund:                  true,
			},
		}

		for k := range payload {
			delete(payload, k)
		}
		payload["settleAction"] = refundPayload.SettleAction
		payload["config"] = batched.ChannelConfigToMap(refundPayload.Config)
		payload["amount"] = refundPayload.Amount
		payload["nonce"] = refundPayload.Nonce
		payload["claims"] = batched.VoucherClaimsToList(refundPayload.Claims)
		payload["responseExtra"] = refundPayload.ResponseExtra.ToMap()
	}

	return nil, nil // Let the facilitator handle the rewritten refund payload
}

// AfterSettleHook returns a hook that updates session state after settlement.
// For deposits: updates balance. For refunds: deletes the session.
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
			if ctx.Result.Extensions != nil {
				channelId := mapStringField(ctx.Result.Extensions, "channelId", "")
				if channelId == "" {
					return nil
				}
				normalizedId := batched.NormalizeChannelId(channelId)
				session, getErr := s.storage.Get(normalizedId)
				if getErr != nil || session == nil {
					return nil //nolint:nilerr // storage error in after-hook is non-fatal
				}
				session.Balance = mapStringField(ctx.Result.Extensions, "balance", session.Balance)
				session.TotalClaimed = mapStringField(ctx.Result.Extensions, "totalClaimed", session.TotalClaimed)

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

		// After refund: delete session
		if batched.IsRefundWithSignaturePayload(payload) {
			// Extract channelId from responseExtra
			if responseExtra, ok := payload["responseExtra"].(map[string]interface{}); ok {
				channelId, _ := responseExtra["channelId"].(string)
				if channelId != "" {
					return s.storage.Delete(batched.NormalizeChannelId(channelId))
				}
			}
			return nil
		}

		return nil
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
