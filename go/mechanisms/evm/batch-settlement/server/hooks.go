package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement/facilitator"
	"github.com/x402-foundation/x402/go/types"
)

const zeroAddress = "0x0000000000000000000000000000000000000000"

// Pending reservation TTL bounds. Cleanup hooks normally clear reservations on
// failure; these bounds release the channel if cleanup never runs.
const (
	minPendingTtlMs = 5_000          // 5 seconds
	maxPendingTtlMs = 10 * 60 * 1000 // 10 minutes
)

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
func (s *BatchSettlementEvmScheme) BeforeVerifyHook() x402.BeforeVerifyHook {
	return func(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()

		isPaid := batchsettlement.IsVoucherPayload(payload) || batchsettlement.IsDepositPayload(payload)
		isZeroCharge := batchsettlement.IsRefundPayload(payload)
		if !isPaid && !isZeroCharge {
			return nil, nil
		}

		voucherFields, _ := payload["voucher"].(map[string]interface{})
		if voucherFields == nil {
			return nil, nil
		}
		rawChannelId, _ := voucherFields["channelId"].(string)
		channelId := batchsettlement.NormalizeChannelId(rawChannelId)
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
			// A live (unexpired) reservation already exists → abort.
			if current != nil && current.PendingRequest != nil && current.PendingRequest.ExpiresAt > now {
				outcomeStatus = "busy"
				return current
			}

			var prevCharged *big.Int
			if current != nil {
				prevCharged, _ = new(big.Int).SetString(current.ChargedCumulativeAmount, 10)
			}
			if prevCharged == nil {
				// When storage has no row yet, derive a sensible charged base so
				// the mismatch check still works for the first request on a
				// brand-new channel.
				switch {
				case !isPaid:
					prevCharged = new(big.Int).Set(signedMax)
				case signedMax.Cmp(reqAmount) < 0:
					prevCharged = big.NewInt(0)
				default:
					prevCharged = new(big.Int).Sub(signedMax, reqAmount)
				}
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
			// Compute the reservation expiry as now + clamp(maxTimeoutSeconds*1000, [min,max]) ms.
			ttl := int64(ctx.Requirements.GetMaxTimeoutSeconds()) * 1000
			if ttl < minPendingTtlMs {
				ttl = minPendingTtlMs
			}
			if ttl > maxPendingTtlMs {
				ttl = maxPendingTtlMs
			}
			next.PendingRequest = &PendingRequest{
				PendingId:          pendingId,
				SignedMaxClaimable: signedMaxStr,
				ExpiresAt:          now + ttl,
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
				Reason:  batchsettlement.ErrChannelBusy,
				Message: "Channel is already processing a request",
			}, nil
		case "mismatch":
			s.RememberChannelSnapshot(ctx.Payload, outcomeChannel)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batchsettlement.ErrCumulativeAmountMismatch,
				Message: "Client voucher base does not match server state",
			}, nil
		case "reserved":
			s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{
				ChannelId:       channelId,
				PendingId:       pendingId,
				ChannelSnapshot: outcomePrevSession,
			})

			// Try a local voucher verification when cached onchain state is fresh.
			// Only voucher payloads (not deposit/refund) qualify.
			if batchsettlement.IsVoucherPayload(payload) {
				localResult := s.verifyVoucherLocally(ctx.Requirements, payload, outcomePrevSession, now)
				if localResult != nil {
					s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{LocalVerify: true})
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
// The smart-wallet (ERC-1271) path is intentionally not supported — vouchers
// signed by a non-zero EOA payerAuthorizer are the only candidates.
func (s *BatchSettlementEvmScheme) verifyVoucherLocally(
	requirements x402.PaymentRequirementsView,
	payload map[string]interface{},
	channel *ChannelSession,
	now int64,
) *x402.VerifyResponse {
	if channel == nil {
		return nil
	}
	// Skip the local fast path when the cached onchain fields for this
	// channel are stale (or never synced) — the dispatcher will fall back
	// to the remote facilitator verify.
	if channel.OnchainSyncedAt == 0 || now-channel.OnchainSyncedAt > s.GetOnchainStateTtlMs() {
		return nil
	}

	vp, err := batchsettlement.VoucherPayloadFromMap(payload)
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
		reason := facilitator.ErrChannelIdMismatch
		var ve *x402.VerifyError
		if errors.As(cfgErr, &ve) && ve.InvalidReason != "" {
			reason = ve.InvalidReason
		}
		return invalidLocalVerifyResponse(payer, reason)
	}

	computed, err := batchsettlement.ComputeChannelId(vp.ChannelConfig, requirements.GetNetwork())
	if err != nil || !strings.EqualFold(computed, channel.ChannelId) {
		return invalidLocalVerifyResponse(payer, facilitator.ErrChannelIdMismatch)
	}

	// Verify the EIP-712 voucher signature against the channel's
	// payerAuthorizer using ECDSA. Smart-wallet (ERC-1271) signatures are
	// intentionally not supported here — the early `vp.ChannelConfig
	// .PayerAuthorizer == zeroAddress` skip above ensures this path only
	// runs against EOA payerAuthorizers.
	sigOk := false
	chainID, sigErr := evm.GetEvmChainId(requirements.GetNetwork())
	if sigErr == nil {
		maxClaimable, ok := new(big.Int).SetString(vp.Voucher.MaxClaimableAmount, 10)
		if !ok {
			return invalidLocalVerifyResponse(payer, facilitator.ErrVoucherSignatureInvalid)
		}
		hash, hashErr := evm.HashTypedData(
			batchsettlement.GetBatchSettlementEip712Domain(chainID),
			batchsettlement.VoucherTypes,
			"Voucher",
			map[string]interface{}{
				"channelId":          vp.Voucher.ChannelId,
				"maxClaimableAmount": maxClaimable,
			},
		)
		if hashErr == nil {
			sigBytes := common.FromHex(vp.Voucher.Signature)
			sigOk, sigErr = evm.VerifyEOASignature(
				hash, sigBytes, common.HexToAddress(vp.ChannelConfig.PayerAuthorizer),
			)
		} else {
			sigErr = hashErr
		}
	}
	if sigErr != nil || !sigOk {
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

// invalidLocalVerifyResponse builds a failed VerifyResponse preserving the
// payer for client-side reporting.
func invalidLocalVerifyResponse(payer, invalidReason string) *x402.VerifyResponse {
	return &x402.VerifyResponse{
		IsValid:       false,
		Payer:         payer,
		InvalidReason: invalidReason,
	}
}

// buildProvisionalChannelFromPayload constructs the minimal ChannelSession
// needed to host a pending reservation when storage has no row yet.
func buildProvisionalChannelFromPayload(
	channelId, signedMax, signature string,
	payload map[string]interface{},
	chargedCumulativeAmount string,
	now int64,
) *ChannelSession {
	cfg := batchsettlement.ChannelConfig{}
	if cfgMap, ok := payload["channelConfig"].(map[string]interface{}); ok {
		if parsed, err := batchsettlement.ChannelConfigFromMap(cfgMap); err == nil {
			cfg = parsed
		}
	}
	return &ChannelSession{
		ChannelId:               channelId,
		ChannelConfig:           cfg,
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
func (s *BatchSettlementEvmScheme) AfterVerifyHook() x402.AfterVerifyHook {
	return func(ctx x402.VerifyResultContext) (*x402.AfterVerifyResult, error) {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil, nil
		}
		if ctx.Result == nil || !ctx.Result.IsValid || ctx.Result.Payer == "" {
			// Verify failed or returned invalid: release this request's reservation.
			_ = s.ClearPendingRequest(ctx.Payload)
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()

		var channelId, signedMaxClaimable, signature string
		var channelConfig *batchsettlement.ChannelConfig
		isRefundVoucher := false

		switch {
		case batchsettlement.IsDepositPayload(payload):
			dp, parseErr := batchsettlement.DepositPayloadFromMap(payload)
			if parseErr != nil {
				return nil, nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = dp.Voucher.ChannelId
			signedMaxClaimable = dp.Voucher.MaxClaimableAmount
			signature = dp.Voucher.Signature
			cfg := dp.ChannelConfig
			channelConfig = &cfg
		case batchsettlement.IsVoucherPayload(payload):
			vp, parseErr := batchsettlement.VoucherPayloadFromMap(payload)
			if parseErr != nil {
				return nil, nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = vp.Voucher.ChannelId
			signedMaxClaimable = vp.Voucher.MaxClaimableAmount
			signature = vp.Voucher.Signature
			cfg := vp.ChannelConfig
			channelConfig = &cfg
		case batchsettlement.IsRefundPayload(payload):
			rp, parseErr := batchsettlement.RefundPayloadFromMap(payload)
			if parseErr != nil {
				return nil, nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = rp.Voucher.ChannelId
			signedMaxClaimable = rp.Voucher.MaxClaimableAmount
			signature = rp.Voucher.Signature
			cfg := rp.ChannelConfig
			channelConfig = &cfg
			isRefundVoucher = true
		default:
			return nil, nil
		}

		ex := ctx.Result.Extra
		balance := mapStringField(ex, "balance", "0")
		totalClaimed := mapStringField(ex, "totalClaimed", "0")
		withdrawRequestedAt := mapIntField(ex, "withdrawRequestedAt", 0)
		refundNonce := mapIntField(ex, "refundNonce", 0)

		normalizedId := batchsettlement.NormalizeChannelId(channelId)
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
			if rc.LocalVerify && batchsettlement.IsVoucherPayload(payload) {
				onchainSyncedAt = current.OnchainSyncedAt
			}
			next := &ChannelSession{
				ChannelId:               normalizedId,
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

// OnVerifyFailureHook releases a reservation when facilitator verification fails.
func (s *BatchSettlementEvmScheme) OnVerifyFailureHook() x402.OnVerifyFailureHook {
	return func(ctx x402.VerifyFailureContext) (*x402.VerifyFailureHookResult, error) {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil, nil
		}
		return nil, s.ClearPendingRequest(ctx.Payload)
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
func (s *BatchSettlementEvmScheme) BeforeSettleHook() x402.BeforeSettleHook {
	return func(ctx x402.SettleContext) (*x402.BeforeHookResult, error) {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()

		// Deposit and refund payloads pass through to the facilitator. Server-
		// owned enrichment for refunds (claims + authorizer signatures) lives
		// in EnrichSettlementPayload below.
		if !batchsettlement.IsVoucherPayload(payload) {
			return nil, nil
		}

		// --- Voucher path: short-circuit on-chain settlement ---

		voucherMap, _ := payload["voucher"].(map[string]interface{})
		if voucherMap == nil {
			return nil, nil
		}
		channelId, _ := voucherMap["channelId"].(string)
		normalizedId := batchsettlement.NormalizeChannelId(channelId)

		session, storageErr := s.storage.Get(normalizedId)
		if storageErr != nil || session == nil {
			return &x402.BeforeHookResult{ //nolint:nilerr // storage error treated as missing session
				Abort:   true,
				Reason:  batchsettlement.ErrMissingChannel,
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
				Reason:  batchsettlement.ErrMissingChannel,
				Message: "No channel record",
			}, nil
		case "pending_mismatch":
			s.TakeRequestContext(ctx.Payload)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batchsettlement.ErrChannelBusy,
				Message: "Concurrent request modified channel state",
			}, nil
		case "cap_exceeded":
			capStr := maxClaimable
			s.TakeRequestContext(ctx.Payload)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batchsettlement.ErrChargeExceedsSignedCumulative,
				Message: fmt.Sprintf("Charged %s exceeds signed max %s", capExceededAmount, capStr),
			}, nil
		}

		s.TakeRequestContext(ctx.Payload)
		// Emit the nested response shape: chargedAmount + channelState.
		skipExtra := &batchsettlement.BatchSettlementPaymentResponseExtra{
			ChargedAmount: ctx.Requirements.GetAmount(),
			ChannelState: &batchsettlement.BatchSettlementChannelStateExtra{
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
				Payer:       committedPrev.ChannelConfig.Payer,
				Amount:      "",
				Extra:       skipExtra.ToMap(),
			},
		}, nil
	}
}

// OnSettleFailureHook releases a reservation when facilitator settlement fails.
func (s *BatchSettlementEvmScheme) OnSettleFailureHook() x402.OnSettleFailureHook {
	return func(ctx x402.SettleFailureContext) (*x402.SettleFailureHookResult, error) {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil, nil
		}
		return nil, s.ClearPendingRequest(ctx.Payload)
	}
}

// EnrichSettlementPayload supplies server-owned settlement-payload fields
// before the facilitator settles. For refund payloads it returns the additive
// `{amount?, refundNonce, claims, refundAuthorizerSignature?, claimAuthorizerSignature?}`
// map; the framework's additive policy (AssertAdditivePayloadEnrichment)
// rejects any attempt to overwrite existing client-set keys.
//
// Returns nil for non-refund payloads. Returns a structured error on
// validation failure; the framework converts it into a settle abort with
// the error string as the reason.
func (s *BatchSettlementEvmScheme) EnrichSettlementPayload(ctx x402.SettleContext) (map[string]interface{}, error) {
	if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
		return nil, nil
	}
	payload := ctx.Payload.GetPayload()
	if !batchsettlement.IsRefundPayload(payload) {
		return nil, nil
	}

	voucherMap, _ := payload["voucher"].(map[string]interface{})
	if voucherMap == nil {
		voucherMap = map[string]interface{}{}
	}
	channelIdStr, _ := voucherMap["channelId"].(string)
	normalizedId := batchsettlement.NormalizeChannelId(channelIdStr)

	session, storageErr := s.storage.Get(normalizedId)
	if storageErr != nil || session == nil {
		return nil, errors.New(batchsettlement.ErrMissingChannel)
	}
	rc := s.ReadRequestContext(ctx.Payload)
	if rc == nil || rc.PendingId == "" || session.PendingRequest == nil ||
		session.PendingRequest.PendingId != rc.PendingId {
		return nil, errors.New(batchsettlement.ErrChannelBusy)
	}

	maxClaimable, _ := voucherMap["maxClaimableAmount"].(string)
	sig, _ := voucherMap["signature"].(string)
	if maxClaimable != session.SignedMaxClaimable {
		return nil, errors.New(batchsettlement.ErrCumulativeAmountMismatch)
	}
	if sig != session.Signature {
		return nil, errors.New(facilitator.ErrVoucherSignatureInvalid)
	}

	config := session.ChannelConfig

	// Refund vouchers are zero-charge: claim's totalClaimed == session.chargedCumulativeAmount.
	claimEntry := batchsettlement.BatchSettlementVoucherClaim{
		Voucher: struct {
			Channel            batchsettlement.ChannelConfig `json:"channel"`
			MaxClaimableAmount string                        `json:"maxClaimableAmount"`
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
		return nil, errors.New(batchsettlement.ErrRefundNoBalance)
	}

	refundAmount := new(big.Int).Set(remainder)
	requestedStr, hasRequestedAmount := payload["amount"].(string)
	hasRequestedAmount = hasRequestedAmount && requestedStr != ""
	if hasRequestedAmount {
		requested, ok := new(big.Int).SetString(requestedStr, 10)
		if !ok || requested.Sign() <= 0 {
			return nil, errors.New(batchsettlement.ErrRefundAmountInvalid)
		}
		if requested.Cmp(remainder) > 0 {
			return nil, errors.New(batchsettlement.ErrRefundAmountExceedsBalance)
		}
		refundAmount = requested
	}

	nonce := fmt.Sprintf("%d", session.RefundNonce)

	enrichment := map[string]interface{}{
		"refundNonce": nonce,
		"claims":      []batchsettlement.BatchSettlementVoucherClaim{claimEntry},
	}
	if !hasRequestedAmount {
		// Only fill `amount` when the client omitted it; otherwise the additive
		// policy would reject the overwrite.
		enrichment["amount"] = refundAmount.String()
	}

	if s.receiverAuthorizerSigner != nil {
		network := ctx.Requirements.GetNetwork()
		authSig, err := s.SignRefund(context.Background(), normalizedId, refundAmount.String(), nonce, network)
		if err != nil {
			return nil, fmt.Errorf("failed to sign refund: %w", err)
		}
		claimAuthSig, err := s.SignClaimBatch(context.Background(), []batchsettlement.BatchSettlementVoucherClaim{claimEntry}, network)
		if err != nil {
			return nil, fmt.Errorf("failed to sign claim batch for refund: %w", err)
		}
		enrichment["refundAuthorizerSignature"] = evm.BytesToHex(authSig)
		enrichment["claimAuthorizerSignature"] = evm.BytesToHex(claimAuthSig)
	}

	// Snapshot the pre-refund channel state for EnrichSettlementResponse, which
	// adds chargedCumulativeAmount onto the post-facilitator response.
	s.RememberChannelSnapshot(ctx.Payload, session)

	return enrichment, nil
}

// AfterSettleHook returns a hook that updates local session state after the
// facilitator settles. Pure state-update — Result.Extra is NOT mutated here;
// EnrichSettlementResponse runs after this hook and additively adds the
// server-owned `chargedCumulativeAmount` (and `chargedAmount` for deposits).
//
// For deposits: read the facilitator's channelState snapshot, compute
// chargedCumulativeAmount = current + requirements.amount, store the new
// session state, and remember the channel snapshot so EnrichSettlementResponse
// can echo chargedCumulativeAmount back to the client.
//
// For refunds: read the facilitator's post-refund channelState, store the
// updated session (or delete on full-refund when balance <= chargedCumulative).
//
// For vouchers: state was already updated in BeforeSettleHook; nothing to do.
func (s *BatchSettlementEvmScheme) AfterSettleHook() x402.AfterSettleHook {
	return func(ctx x402.SettleResultContext) error {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil
		}
		if ctx.Result == nil || !ctx.Result.Success {
			return nil
		}

		payload := ctx.Payload.GetPayload()

		// --- Deposit: storage update from facilitator channelState ---
		if batchsettlement.IsDepositPayload(payload) {
			dp, parseErr := batchsettlement.DepositPayloadFromMap(payload)
			if parseErr != nil {
				log.Printf("[batched] AfterSettle deposit: parse payload failed: %v", parseErr)
				return nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			normalizedId := batchsettlement.NormalizeChannelId(dp.Voucher.ChannelId)
			rc := s.ReadRequestContext(ctx.Payload)
			var pendingId string
			if rc != nil {
				pendingId = rc.PendingId
			}

			// Read channelState from facilitator response.
			cs := readChannelStateFromExtra(ctx.Result.Extra)
			now := time.Now().UnixMilli()
			reqAmount, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
			if reqAmount == nil {
				reqAmount = big.NewInt(0)
			}

			updateRes, updateErr := s.storage.UpdateChannel(normalizedId, func(current *ChannelSession) *ChannelSession {
				if current == nil {
					return current
				}
				if pendingId == "" || current.PendingRequest == nil ||
					current.PendingRequest.PendingId != pendingId {
					return current
				}
				curCharged, _ := new(big.Int).SetString(current.ChargedCumulativeAmount, 10)
				if curCharged == nil {
					curCharged = big.NewInt(0)
				}
				next := *current
				next.ChannelConfig = dp.ChannelConfig
				next.ChargedCumulativeAmount = new(big.Int).Add(curCharged, reqAmount).String()
				next.SignedMaxClaimable = dp.Voucher.MaxClaimableAmount
				next.Signature = dp.Voucher.Signature
				if cs != nil {
					if cs.Balance != "" {
						next.Balance = cs.Balance
					}
					if cs.TotalClaimed != "" {
						next.TotalClaimed = cs.TotalClaimed
					}
					if cs.WithdrawRequestedAt != 0 {
						next.WithdrawRequestedAt = cs.WithdrawRequestedAt
					}
					if cs.RefundNonce != "" {
						if n, ok := new(big.Int).SetString(cs.RefundNonce, 10); ok {
							next.RefundNonce = int(n.Int64())
						}
					}
				}
				next.OnchainSyncedAt = now
				next.LastRequestTimestamp = now
				next.PendingRequest = nil
				return &next
			})
			if updateErr != nil {
				return updateErr
			}
			if updateRes.Status == ChannelUpdated && updateRes.Channel != nil {
				// Snapshot for EnrichSettlementResponse to read
				// chargedCumulativeAmount additively into the response.
				s.RememberChannelSnapshot(ctx.Payload, updateRes.Channel)
			}
			return nil
		}

		// --- Refund: storage update from facilitator post-refund snapshot ---
		if batchsettlement.IsEnrichedRefundPayload(payload) {
			refundPayload, err := batchsettlement.EnrichedRefundPayloadFromMap(payload)
			if err != nil {
				log.Printf("[batched] AfterSettle refund: parse payload failed: %v", err)
				return nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId, err := batchsettlement.ComputeChannelId(refundPayload.ChannelConfig, ctx.Requirements.GetNetwork())
			if err != nil {
				log.Printf("[batched] AfterSettle refund: ComputeChannelId failed: %v", err)
				return nil //nolint:nilerr
			}
			normalizedId := batchsettlement.NormalizeChannelId(channelId)
			rc := s.ReadRequestContext(ctx.Payload)
			var pendingId string
			if rc != nil {
				pendingId = rc.PendingId
			}

			snapshot := readChannelStateFromExtra(ctx.Result.Extra)
			if snapshot == nil {
				return nil
			}
			now := time.Now().UnixMilli()
			outcome := ""

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
				postBalance, _ := new(big.Int).SetString(snapshot.Balance, 10)
				if postBalance == nil {
					postBalance = big.NewInt(0)
				}
				curCharged, _ := new(big.Int).SetString(current.ChargedCumulativeAmount, 10)
				if curCharged == nil {
					curCharged = big.NewInt(0)
				}
				if postBalance.Cmp(curCharged) <= 0 {
					// Full refund: delete the channel session.
					outcome = "deleted"
					return nil
				}
				next := *current
				if snapshot.Balance != "" {
					next.Balance = snapshot.Balance
				}
				if snapshot.TotalClaimed != "" {
					next.TotalClaimed = snapshot.TotalClaimed
				}
				if snapshot.WithdrawRequestedAt != 0 {
					next.WithdrawRequestedAt = snapshot.WithdrawRequestedAt
				}
				if snapshot.RefundNonce != "" {
					if n, ok := new(big.Int).SetString(snapshot.RefundNonce, 10); ok {
						next.RefundNonce = int(n.Int64())
					}
				}
				next.OnchainSyncedAt = now
				next.LastRequestTimestamp = now
				next.PendingRequest = nil
				outcome = "updated"
				return &next
			})
			if updateErr != nil {
				return updateErr
			}
			if outcome == "pending_mismatch" {
				return errors.New(batchsettlement.ErrChannelBusy)
			}
			return nil
		}

		return nil
	}
}

// EnrichSettlementResponse supplies server-owned settlement-response fields
// after the facilitator settles. Returns the additive
// `{channelState: {chargedCumulativeAmount}, chargedAmount?}` map so the
// framework can deep-merge it into result.extra without overwriting the
// channelState.{balance,totalClaimed,...} fields the facilitator already
// populated.
//
// The snapshot is set by EnrichSettlementPayload (refund) or by
// AfterSettleHook (deposit) via RememberChannelSnapshot.
func (s *BatchSettlementEvmScheme) EnrichSettlementResponse(ctx x402.SettleResultContext) (map[string]interface{}, error) {
	if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
		return nil, nil
	}
	payload := ctx.Payload.GetPayload()
	if batchsettlement.IsVoucherPayload(payload) {
		return nil, nil
	}
	channel := s.TakeChannelSnapshot(ctx.Payload)
	if channel == nil {
		return nil, nil
	}
	out := map[string]interface{}{
		"channelState": map[string]interface{}{
			"chargedCumulativeAmount": channel.ChargedCumulativeAmount,
		},
	}
	if batchsettlement.IsDepositPayload(payload) {
		out["chargedAmount"] = ctx.Requirements.GetAmount()
	}
	return out, nil
}

// readChannelStateFromExtra extracts the nested channelState map from a
// settle-response extra. Returns nil when absent or wrong-typed.
func readChannelStateFromExtra(extra map[string]interface{}) *batchsettlement.BatchSettlementChannelStateExtra {
	if extra == nil {
		return nil
	}
	raw, ok := extra["channelState"].(map[string]interface{})
	if !ok {
		return nil
	}
	out := &batchsettlement.BatchSettlementChannelStateExtra{}
	if v, ok := raw["channelId"].(string); ok {
		out.ChannelId = v
	}
	if v, ok := raw["balance"].(string); ok {
		out.Balance = v
	} else if v, ok := raw["balance"].(float64); ok {
		out.Balance = fmt.Sprintf("%.0f", v)
	}
	if v, ok := raw["totalClaimed"].(string); ok {
		out.TotalClaimed = v
	} else if v, ok := raw["totalClaimed"].(float64); ok {
		out.TotalClaimed = fmt.Sprintf("%.0f", v)
	}
	if v, ok := raw["withdrawRequestedAt"].(float64); ok {
		out.WithdrawRequestedAt = int(v)
	} else if v, ok := raw["withdrawRequestedAt"].(int); ok {
		out.WithdrawRequestedAt = v
	}
	if v, ok := raw["refundNonce"].(string); ok {
		out.RefundNonce = v
	} else if v, ok := raw["refundNonce"].(float64); ok {
		out.RefundNonce = fmt.Sprintf("%.0f", v)
	}
	return out
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
