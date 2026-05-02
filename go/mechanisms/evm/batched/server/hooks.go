package server

import (
	"context"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batched/facilitator"
	"github.com/x402-foundation/x402/go/types"
)

const zeroAddress = "0x0000000000000000000000000000000000000000"

// Pending reservation TTL bounds. Cleanup hooks normally clear reservations on
// failure; these bounds release the channel if cleanup never runs.
const (
	minPendingTtlMs = 5_000          // 5 seconds
	maxPendingTtlMs = 10 * 60 * 1000 // 10 minutes
)

// pendingExpiresAt returns now + clamp(maxTimeoutSeconds*1000, [min,max]) ms.
func pendingExpiresAt(maxTimeoutSeconds int, now int64) int64 {
	requested := int64(maxTimeoutSeconds) * 1000
	if requested < 0 {
		requested = 0
	}
	ttl := requested
	if ttl < minPendingTtlMs {
		ttl = minPendingTtlMs
	}
	if ttl > maxPendingTtlMs {
		ttl = maxPendingTtlMs
	}
	return now + ttl
}

// isPendingLive reports whether the reservation still blocks same-channel work.
func isPendingLive(p *PendingRequest, now int64) bool {
	return p != nil && p.ExpiresAt > now
}

// BeforeVerifyHook reserves the channel for this request via an atomic
// UpdateChannel call. Three outcomes are possible:
//   - busy: a live (unexpired) reservation already exists → abort
//   - mismatch: client's signed cap does not match server's expected base →
//     remember the snapshot so EnrichPaymentRequiredResponse can return
//     corrective state, then abort with ErrCumulativeAmountMismatch
//   - reserved: write a new PendingRequest into storage and merge the
//     channelId/pendingId/snapshot into the per-payload request context so
//     AfterVerifyHook / BeforeSettleHook can commit (or release) it
//
// When no local channel record exists, a provisional one is created so the
// reservation has somewhere to live; ClearPendingRequest will delete it
// later if the request fails (snapshot is nil).
func (s *BatchedEvmScheme) BeforeVerifyHook() x402.BeforeVerifyHook {
	return func(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
		if ctx.Requirements.GetScheme() != batched.SchemeBatched {
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()

		isPaid := batched.IsVoucherPayload(payload) || batched.IsDepositPayload(payload)
		isZeroCharge := batched.IsRefundPayload(payload)
		if !isPaid && !isZeroCharge {
			return nil, nil
		}

		voucherFields, _ := payload["voucher"].(map[string]interface{})
		if voucherFields == nil {
			return nil, nil
		}
		rawChannelId, _ := voucherFields["channelId"].(string)
		channelId := batched.NormalizeChannelId(rawChannelId)
		signedMaxStr, _ := voucherFields["maxClaimableAmount"].(string)
		signature, _ := voucherFields["signature"].(string)
		signedMax, _ := new(big.Int).SetString(signedMaxStr, 10)
		if signedMax == nil {
			signedMax = big.NewInt(0)
		}

		reqAmount, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
		if reqAmount == nil {
			reqAmount = big.NewInt(0)
		}

		now := time.Now().UnixMilli()
		pendingNonce, err := evm.CreateNonce()
		if err != nil {
			return nil, fmt.Errorf("create pending nonce: %w", err)
		}
		pendingId := pendingNonce

		var (
			outcomeStatus      string // "busy" | "mismatch" | "reserved"
			outcomeChannel     *ChannelSession
			outcomePrevSession *ChannelSession // when "reserved" with existing row
		)

		_, updateErr := s.storage.UpdateChannel(channelId, func(current *ChannelSession) *ChannelSession {
			if current != nil && isPendingLive(current.PendingRequest, now) {
				outcomeStatus = "busy"
				return current
			}

			var prevCharged *big.Int
			if current != nil {
				prevCharged, _ = new(big.Int).SetString(current.ChargedCumulativeAmount, 10)
			}
			if prevCharged == nil {
				prevCharged = inferMissingChargedAmount(signedMax, reqAmount, isPaid)
			}

			var expectedMax *big.Int
			if isZeroCharge {
				expectedMax = new(big.Int).Set(prevCharged)
			} else {
				expectedMax = new(big.Int).Add(prevCharged, reqAmount)
			}

			if signedMax.Cmp(expectedMax) != 0 {
				outcomeStatus = "mismatch"
				if current != nil {
					outcomeChannel = current
				} else {
					outcomeChannel = buildProvisionalChannelFromPayload(
						channelId, signedMaxStr, signature, payload, prevCharged.String(), now,
					)
				}
				return current
			}

			outcomeStatus = "reserved"
			outcomePrevSession = current
			next := &ChannelSession{}
			if current != nil {
				cp := *current
				next = &cp
			} else {
				prov := buildProvisionalChannelFromPayload(
					channelId, signedMaxStr, signature, payload, prevCharged.String(), now,
				)
				next = prov
			}
			next.PendingRequest = &PendingRequest{
				PendingId:          pendingId,
				SignedMaxClaimable: signedMaxStr,
				ExpiresAt:          pendingExpiresAt(ctx.Requirements.GetMaxTimeoutSeconds(), now),
			}
			next.LastRequestTimestamp = now
			return next
		})
		if updateErr != nil {
			return nil, updateErr
		}

		switch outcomeStatus {
		case "busy":
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batched.ErrChannelBusy,
				Message: "Channel is already processing a request",
			}, nil
		case "mismatch":
			s.RememberChannelSnapshot(ctx.Payload, outcomeChannel)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batched.ErrCumulativeAmountMismatch,
				Message: "Client voucher base does not match server state",
			}, nil
		case "reserved":
			s.MergeRequestContext(ctx.Payload, BatchedRequestContext{
				ChannelId:       channelId,
				PendingId:       pendingId,
				ChannelSnapshot: outcomePrevSession,
			})

			// Try a local voucher verification when cached onchain state is fresh.
			// Only voucher payloads (not deposit/refund) qualify.
			if batched.IsVoucherPayload(payload) {
				localResult := s.verifyVoucherLocally(ctx.Requirements, payload, outcomePrevSession, now)
				if localResult != nil {
					s.MergeRequestContext(ctx.Payload, BatchedRequestContext{LocalVerify: true})
					return &x402.BeforeHookResult{
						Skip:             true,
						SkipVerifyResult: localResult,
					}, nil
				}
			}
		}
		return nil, nil
	}
}

// verifyVoucherLocally returns a successful VerifyResponse when the voucher can
// be verified entirely against locally cached channel state — i.e. the cache is
// within the configured TTL of last onchain sync, the channel config validates,
// the recomputed channelId matches, and the voucher signature recovers to the
// payerAuthorizer. Returns nil on any check that requires falling back to the
// facilitator, and an explicit invalid VerifyResponse when a local check fails.
//
// Mirrors TS `verifyVoucherLocally`. The smart-wallet (ERC-1271) path is
// intentionally not supported — vouchers signed by a non-zero EOA payerAuthorizer
// are the only candidates.
func (s *BatchedEvmScheme) verifyVoucherLocally(
	requirements x402.PaymentRequirementsView,
	payload map[string]interface{},
	channel *ChannelSession,
	now int64,
) *x402.VerifyResponse {
	if channel == nil {
		return nil
	}
	if !isOnchainStateFresh(channel, s.GetOnchainStateTtlMs(), now) {
		return nil
	}

	vp, err := batched.VoucherPayloadFromMap(payload)
	if err != nil {
		return nil
	}
	if strings.EqualFold(vp.ChannelConfig.PayerAuthorizer, zeroAddress) {
		return nil
	}

	payer := vp.ChannelConfig.Payer

	// Construct a types.PaymentRequirements from the view to reuse the
	// shared validator (avoids duplicating receiver/token/delay/channelId checks).
	reqs := types.PaymentRequirements{
		Scheme:            requirements.GetScheme(),
		Network:           requirements.GetNetwork(),
		Asset:             requirements.GetAsset(),
		Amount:            requirements.GetAmount(),
		PayTo:             requirements.GetPayTo(),
		MaxTimeoutSeconds: requirements.GetMaxTimeoutSeconds(),
		Extra:             requirements.GetExtra(),
	}
	if cfgErr := facilitator.ValidateChannelConfig(vp.ChannelConfig, vp.Voucher.ChannelId, reqs); cfgErr != nil {
		return invalidLocalVerifyResponse(payer, extractInvalidReason(cfgErr, facilitator.ErrChannelIdMismatch))
	}

	computed, err := batched.ComputeChannelId(vp.ChannelConfig, requirements.GetNetwork())
	if err != nil || !strings.EqualFold(computed, channel.ChannelId) {
		return invalidLocalVerifyResponse(payer, facilitator.ErrChannelIdMismatch)
	}

	sigOk, err := verifyLocalVoucherSignature(vp, requirements.GetNetwork())
	if err != nil || !sigOk {
		return invalidLocalVerifyResponse(payer, facilitator.ErrVoucherSignatureInvalid)
	}

	maxClaimable, ok := new(big.Int).SetString(vp.Voucher.MaxClaimableAmount, 10)
	if !ok {
		return nil
	}
	balance, _ := new(big.Int).SetString(channel.Balance, 10)
	if balance == nil {
		balance = big.NewInt(0)
	}
	if maxClaimable.Cmp(balance) > 0 {
		return invalidLocalVerifyResponse(payer, facilitator.ErrMaxClaimableExceedsBal)
	}
	totalClaimed, _ := new(big.Int).SetString(channel.TotalClaimed, 10)
	if totalClaimed == nil {
		totalClaimed = big.NewInt(0)
	}
	if maxClaimable.Cmp(totalClaimed) <= 0 {
		return invalidLocalVerifyResponse(payer, facilitator.ErrMaxClaimableTooLow)
	}

	return &x402.VerifyResponse{
		IsValid: true,
		Payer:   payer,
		Extra: map[string]interface{}{
			"channelId":           vp.Voucher.ChannelId,
			"balance":             channel.Balance,
			"totalClaimed":        channel.TotalClaimed,
			"withdrawRequestedAt": channel.WithdrawRequestedAt,
			"refundNonce":         fmt.Sprintf("%d", channel.RefundNonce),
		},
	}
}

// isOnchainStateFresh reports whether the cached onchain fields for the
// channel are still within the configured freshness window.
func isOnchainStateFresh(channel *ChannelSession, ttlMs, now int64) bool {
	if channel == nil || channel.OnchainSyncedAt == 0 {
		return false
	}
	return now-channel.OnchainSyncedAt <= ttlMs
}

// verifyLocalVoucherSignature verifies the EIP-712 voucher signature against
// the channel's payerAuthorizer using ECDSA. Smart-wallet (ERC-1271) signatures
// are intentionally not supported — callers must skip the local path when the
// payerAuthorizer is the zero address.
func verifyLocalVoucherSignature(vp *batched.BatchedVoucherPayload, network string) (bool, error) {
	chainID, err := evm.GetEvmChainId(network)
	if err != nil {
		return false, err
	}
	maxClaimable, ok := new(big.Int).SetString(vp.Voucher.MaxClaimableAmount, 10)
	if !ok {
		return false, fmt.Errorf("invalid maxClaimableAmount")
	}
	hash, err := evm.HashTypedData(
		batched.GetBatchSettlementEip712Domain(chainID),
		batched.VoucherTypes,
		"Voucher",
		map[string]interface{}{
			"channelId":          vp.Voucher.ChannelId,
			"maxClaimableAmount": maxClaimable,
		},
	)
	if err != nil {
		return false, err
	}
	sig := common.FromHex(vp.Voucher.Signature)
	return evm.VerifyEOASignature(hash, sig, common.HexToAddress(vp.ChannelConfig.PayerAuthorizer))
}

// invalidLocalVerifyResponse builds a failed VerifyResponse preserving the
// payer for client-side reporting.
func invalidLocalVerifyResponse(payer, invalidReason string) *x402.VerifyResponse {
	return &x402.VerifyResponse{
		IsValid:       false,
		Payer:         payer,
		InvalidReason: invalidReason,
	}
}

// extractInvalidReason pulls a x402.VerifyError's InvalidReason out of err,
// falling back to defaultReason when err is not a VerifyError.
func extractInvalidReason(err error, defaultReason string) string {
	if err == nil {
		return defaultReason
	}
	if ve, ok := err.(*x402.VerifyError); ok && ve.InvalidReason != "" {
		return ve.InvalidReason
	}
	return defaultReason
}

// inferMissingChargedAmount mirrors TS `inferMissingLocalChargedAmount`:
// when storage has no row yet, derive a sensible charged base so the mismatch
// check still works for the first request on a brand-new channel.
func inferMissingChargedAmount(signedMax, price *big.Int, isPaid bool) *big.Int {
	if !isPaid {
		return new(big.Int).Set(signedMax)
	}
	if signedMax.Cmp(price) < 0 {
		return big.NewInt(0)
	}
	return new(big.Int).Sub(signedMax, price)
}

// buildProvisionalChannelFromPayload constructs the minimal ChannelSession
// needed to host a pending reservation when storage has no row yet.
func buildProvisionalChannelFromPayload(
	channelId, signedMax, signature string,
	payload map[string]interface{},
	chargedCumulativeAmount string,
	now int64,
) *ChannelSession {
	cfg := batched.ChannelConfig{}
	if cfgMap, ok := payload["channelConfig"].(map[string]interface{}); ok {
		if parsed, err := batched.ChannelConfigFromMap(cfgMap); err == nil {
			cfg = parsed
		}
	}
	return &ChannelSession{
		ChannelId:               channelId,
		ChannelConfig:           cfg,
		Payer:                   strings.ToLower(cfg.Payer),
		ChargedCumulativeAmount: chargedCumulativeAmount,
		SignedMaxClaimable:      signedMax,
		Signature:               signature,
		Balance:                 "0",
		TotalClaimed:            "0",
		WithdrawRequestedAt:     0,
		RefundNonce:             0,
		LastRequestTimestamp:    now,
	}
}

// AfterVerifyHook returns a hook that persists channel session state after
// successful verification.  It extracts channelId, voucher signature, and
// onchain snapshot from the verify response and stores/updates the session.
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
			// Verify failed or returned invalid: release this request's reservation.
			_ = s.ClearPendingRequest(ctx.Payload)
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
		now := time.Now().UnixMilli()

		// Only commit when current.PendingRequest.PendingId matches this
		// request's reservation. Without a valid reservation context (e.g.
		// hooks invoked out-of-band by tests), fall back to a plain Set so
		// existing direct-call behavior is preserved.
		rc := s.ReadRequestContext(ctx.Payload)
		if rc == nil || rc.PendingId == "" {
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
				LastRequestTimestamp:    now,
				OnchainSyncedAt:         now,
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

		// When local verify already succeeded for a voucher payload, the cached
		// onchain fields were trusted as-is — preserve the existing
		// OnchainSyncedAt rather than treating this commit as a fresh sync.
		updateRes, err := s.storage.UpdateChannel(normalizedId, func(current *ChannelSession) *ChannelSession {
			if current == nil || current.PendingRequest == nil ||
				current.PendingRequest.PendingId != rc.PendingId {
				return current
			}
			onchainSyncedAt := now
			if rc.LocalVerify && batched.IsVoucherPayload(payload) {
				onchainSyncedAt = current.OnchainSyncedAt
			}
			next := &ChannelSession{
				ChannelId:               normalizedId,
				Payer:                   strings.ToLower(payer),
				ChargedCumulativeAmount: current.ChargedCumulativeAmount,
				SignedMaxClaimable:      signedMaxClaimable,
				Signature:               signature,
				Balance:                 balance,
				TotalClaimed:            totalClaimed,
				WithdrawRequestedAt:     withdrawRequestedAt,
				RefundNonce:             refundNonce,
				OnchainSyncedAt:         onchainSyncedAt,
				LastRequestTimestamp:    now,
				PendingRequest:          current.PendingRequest,
			}
			if channelConfig != nil {
				next.ChannelConfig = *channelConfig
			} else {
				next.ChannelConfig = current.ChannelConfig
			}
			return next
		})
		if err != nil {
			return nil, err
		}
		if updateRes.Status == ChannelUpdated && updateRes.Channel != nil {
			s.RememberChannelSnapshot(ctx.Payload, updateRes.Channel)
		}

		if isRefundVoucher && updateRes.Status == ChannelUpdated {
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
//   - Increments chargedCumulativeAmount locally via UpdateChannel
//   - Returns a Skip result so onchain settlement is NOT triggered
//   - If the voucher has refund=true, rewrites the payload to a refund settle
//     action that the facilitator will execute onchain
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
					Reason:  batched.ErrMissingChannel,
					Message: "No session for channel; verify may not have completed",
				}, nil
			}
			return s.handleRefundRewrite(ctx, session, payload)
		}

		// --- Voucher path: skip onchain settlement ---
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
				Reason:  batched.ErrMissingChannel,
				Message: "No session for channel; verify may not have completed",
			}, nil
		}

		_ = session // existence already enforced above; UpdateChannel re-reads under lock

		increment, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
		if increment == nil {
			increment = big.NewInt(0)
		}
		maxClaimable, _ := voucherMap["maxClaimableAmount"].(string)
		sig, _ := voucherMap["signature"].(string)
		rc := s.ReadRequestContext(ctx.Payload)
		var pendingId string
		if rc != nil {
			pendingId = rc.PendingId
		}

		var (
			outcome             string // "missing" | "pending_mismatch" | "cap_exceeded" | "committed"
			capExceededAmount   string
			committedPrev       *ChannelSession
			committedNew        *ChannelSession
			committedNewCharged *big.Int
		)

		_, updateErr := s.storage.UpdateChannel(normalizedId, func(current *ChannelSession) *ChannelSession {
			if current == nil {
				outcome = "missing"
				return current
			}
			if pendingId == "" || current.PendingRequest == nil ||
				current.PendingRequest.PendingId != pendingId {
				outcome = "pending_mismatch"
				return current
			}
			curCharged, _ := new(big.Int).SetString(current.ChargedCumulativeAmount, 10)
			if curCharged == nil {
				curCharged = big.NewInt(0)
			}
			next := new(big.Int).Add(curCharged, increment)
			cap2, _ := new(big.Int).SetString(maxClaimable, 10)
			if cap2 != nil && next.Cmp(cap2) > 0 {
				outcome = "cap_exceeded"
				capExceededAmount = next.String()
				cleared := *current
				cleared.PendingRequest = nil
				return &cleared
			}
			updated := *current
			updated.ChargedCumulativeAmount = next.String()
			updated.SignedMaxClaimable = maxClaimable
			updated.Signature = sig
			updated.LastRequestTimestamp = time.Now().UnixMilli()
			updated.PendingRequest = nil
			outcome = "committed"
			committedPrev = current
			committedNew = &updated
			committedNewCharged = next
			return &updated
		})
		if updateErr != nil {
			return nil, updateErr
		}

		switch outcome {
		case "missing":
			s.TakeRequestContext(ctx.Payload)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batched.ErrMissingChannel,
				Message: "No channel record",
			}, nil
		case "pending_mismatch":
			s.TakeRequestContext(ctx.Payload)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batched.ErrChannelBusy,
				Message: "Concurrent request modified channel state",
			}, nil
		case "cap_exceeded":
			capStr := maxClaimable
			s.TakeRequestContext(ctx.Payload)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batched.ErrChargeExceedsSignedCumulative,
				Message: fmt.Sprintf("Charged %s exceeds signed max %s", capExceededAmount, capStr),
			}, nil
		}

		s.TakeRequestContext(ctx.Payload)
		// Emit nested wire shape: chargedAmount + channelState. Mirrors TS.
		skipExtra := &batched.BatchedPaymentResponseExtra{
			ChargedAmount: ctx.Requirements.GetAmount(),
			ChannelState: &batched.BatchedChannelStateExtra{
				ChannelId:               normalizedId,
				Balance:                 committedNew.Balance,
				TotalClaimed:            committedNew.TotalClaimed,
				WithdrawRequestedAt:     committedNew.WithdrawRequestedAt,
				RefundNonce:             fmt.Sprintf("%d", committedNew.RefundNonce),
				ChargedCumulativeAmount: committedNewCharged.String(),
			},
		}
		return &x402.BeforeHookResult{
			Skip: true,
			SkipResult: &x402.SettleResponse{
				Success:     true,
				Transaction: "",
				Network:     x402.Network(ctx.Requirements.GetNetwork()),
				Payer:       committedPrev.Payer,
				Amount:      "",
				Extra:       skipExtra.ToMap(),
			},
		}, nil
	}
}

// handleRefundRewrite rewrites a refund-flagged (zero-charge) voucher into a
// refundWithSignature settle-action payload for the facilitator to execute
// onchain. Supports an optional partial refundAmount in the voucher; otherwise
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
			Reason:  batched.ErrRefundNoBalance,
			Message: "Channel has no remaining balance to refund",
		}, nil
	}

	refundAmount := new(big.Int).Set(remainder)
	if requestedStr, ok := payload["amount"].(string); ok && requestedStr != "" {
		requested, ok := new(big.Int).SetString(requestedStr, 10)
		if !ok || requested.Sign() <= 0 {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batched.ErrRefundAmountInvalid,
				Message: "refundAmount must be a positive integer",
			}, nil
		}
		if requested.Cmp(remainder) > 0 {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batched.ErrRefundAmountExceedsBalance,
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

		// After deposit: update session balance from response and reshape the
		// response extra into the nested wire format.
		if batched.IsDepositPayload(payload) {
			if ctx.Result.Extra == nil {
				return nil
			}
			parsedExtra, _ := batched.PaymentResponseExtraFromMap(ctx.Result.Extra)
			channelId := ""
			if parsedExtra != nil && parsedExtra.ChannelState != nil {
				channelId = parsedExtra.ChannelState.ChannelId
			}
			if channelId == "" {
				return nil
			}
			normalizedId := batched.NormalizeChannelId(channelId)
			session, getErr := s.storage.Get(normalizedId)
			if getErr != nil {
				log.Printf("[batched] AfterSettle deposit: storage.Get(%s) failed: %v", normalizedId, getErr)
				return nil //nolint:nilerr // storage error in after-hook is non-fatal
			}
			if session == nil {
				return nil
			}
			defaults := &batched.BatchedChannelStateExtra{
				Balance:             session.Balance,
				TotalClaimed:        session.TotalClaimed,
				WithdrawRequestedAt: session.WithdrawRequestedAt,
				RefundNonce:         fmt.Sprintf("%d", session.RefundNonce),
			}
			cs := mergeChannelStateFromResponse(parsedExtra, defaults)
			session.Balance = cs.Balance
			session.TotalClaimed = cs.TotalClaimed

			chargedAmount := ""
			if responseExtra, ok := payload["responseExtra"].(map[string]interface{}); ok {
				if charged, ok := responseExtra["chargedCumulativeAmount"].(string); ok {
					session.ChargedCumulativeAmount = charged
					chargedAmount = ctx.Requirements.GetAmount()
				}
			}

			cs.ChannelId = normalizedId
			cs.ChargedCumulativeAmount = session.ChargedCumulativeAmount
			out := &batched.BatchedPaymentResponseExtra{
				ChargedAmount: chargedAmount,
				ChannelState:  cs,
			}
			ctx.Result.Extra = out.ToMap()

			// Clear the pending-request reservation that BeforeVerifyHook set —
			// the voucher path does this in BeforeSettle, but the deposit path
			// passes through to the facilitator so cleanup must happen here.
			// Without this, the 5s TTL blocks the next voucher with a stale
			// "busy" 402 until expiry.
			session.PendingRequest = nil

			return s.storage.Set(normalizedId, session)
		}

		// After refund: reconcile session — delete on full refund (remainder<=0),
		// otherwise update balance and bump refundNonce.
		if batched.IsEnrichedRefundPayload(payload) {
			refundPayload, err := batched.EnrichedRefundPayloadFromMap(payload)
			if err != nil {
				log.Printf("[batched] AfterSettle refund: parse payload failed: %v", err)
				return nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId, err := batched.ComputeChannelId(refundPayload.ChannelConfig, ctx.Requirements.GetNetwork())
			if err != nil {
				log.Printf("[batched] AfterSettle refund: ComputeChannelId failed: %v", err)
				return nil //nolint:nilerr
			}
			normalizedId := batched.NormalizeChannelId(channelId)
			prevSession, _ := s.storage.Get(normalizedId)

			var defaults *batched.BatchedChannelStateExtra
			if prevSession != nil {
				amountBig, _ := new(big.Int).SetString(refundPayload.Amount, 10)
				if amountBig == nil {
					amountBig = big.NewInt(0)
				}
				defaults = buildRefundChannelStateSnapshot(prevSession, normalizedId, amountBig)
			}
			if defaults == nil {
				defaults = &batched.BatchedChannelStateExtra{
					ChannelId:   normalizedId,
					Balance:     "0",
					RefundNonce: "0",
				}
			}

			extra := ctx.Result.Extra
			refundedAmount := refundPayload.Amount

			// Reshape into nested wire format. Allow the facilitator's response
			// extra to override default values.
			parsedExtra, _ := batched.PaymentResponseExtraFromMap(extra)
			cs := mergeChannelStateFromResponse(parsedExtra, defaults)
			out := &batched.BatchedPaymentResponseExtra{ChannelState: cs}
			ctx.Result.Extra = out.ToMap()

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

// mergeChannelStateFromResponse layers a parsed response extra's channelState
// over a defaults snapshot. Only non-zero fields override the defaults so
// callers can pre-populate sensible values from local session state.
func mergeChannelStateFromResponse(
	parsed *batched.BatchedPaymentResponseExtra,
	defaults *batched.BatchedChannelStateExtra,
) *batched.BatchedChannelStateExtra {
	cs := &batched.BatchedChannelStateExtra{}
	if defaults != nil {
		*cs = *defaults
	}
	if parsed == nil || parsed.ChannelState == nil {
		return cs
	}
	src := parsed.ChannelState
	if src.ChannelId != "" {
		cs.ChannelId = src.ChannelId
	}
	if src.Balance != "" {
		cs.Balance = src.Balance
	}
	if src.TotalClaimed != "" {
		cs.TotalClaimed = src.TotalClaimed
	}
	if src.WithdrawRequestedAt != 0 {
		cs.WithdrawRequestedAt = src.WithdrawRequestedAt
	}
	if src.RefundNonce != "" {
		cs.RefundNonce = src.RefundNonce
	}
	if src.ChargedCumulativeAmount != "" {
		cs.ChargedCumulativeAmount = src.ChargedCumulativeAmount
	}
	return cs
}

// buildRefundChannelStateSnapshot mirrors the TS helper of the same name: it
// builds the BatchedChannelStateExtra describing channel state immediately
// after a cooperative refund of `refundAmount` is applied to `session`.
func buildRefundChannelStateSnapshot(session *ChannelSession, channelId string, refundAmount *big.Int) *batched.BatchedChannelStateExtra {
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
	return &batched.BatchedChannelStateExtra{
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
