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
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
	"github.com/x402-foundation/x402/go/v2/types"
)

const zeroAddress = "0x0000000000000000000000000000000000000000"

// Pending reservation TTL bounds. Cleanup hooks normally release admission
// locks on failure; these bounds release the channel if cleanup never runs.
const (
	minPendingTtlMs = 5_000          // 5 seconds
	maxPendingTtlMs = 10 * 60 * 1000 // 10 minutes
)

func pendingTtlMs(maxTimeoutSeconds int) int64 {
	ttl := int64(maxTimeoutSeconds) * 1000
	if ttl < minPendingTtlMs {
		ttl = minPendingTtlMs
	}
	if ttl > maxPendingTtlMs {
		ttl = maxPendingTtlMs
	}
	return ttl
}

type admissionHold int

const (
	admissionSelf admissionHold = iota
	admissionOther
	admissionNone
)

// inspectAdmission classifies whether this request still holds the admission
// lock, another request holds it, or no lock is present (lost/expired or lock
// store I/O down). Implementation/parse errors fail closed.
func inspectAdmission(scheme *BatchSettlementEvmScheme, channelId, pendingId string) (admissionHold, error) {
	locks := scheme.GetLockStorage()
	if pendingId != "" {
		held, err := locks.IsHeld(channelId, pendingId)
		if impl := RethrowLockImplementationError(err); impl != nil {
			return admissionNone, impl
		}
		if err != nil {
			return admissionNone, nil //nolint:nilerr // lock I/O failure → optimistic none
		}
		if held {
			return admissionSelf, nil
		}
	}
	held, err := locks.IsHeld(channelId, "")
	if impl := RethrowLockImplementationError(err); impl != nil {
		return admissionNone, impl
	}
	if err != nil {
		return admissionNone, nil //nolint:nilerr // lock I/O failure → optimistic none
	}
	if held {
		return admissionOther, nil
	}
	return admissionNone, nil
}

func verificationStateUnavailable() *x402.BeforeHookResult {
	return &x402.BeforeHookResult{
		Abort:   true,
		Reason:  batchsettlement.ErrVerificationStateUnavailable,
		Message: "Unable to establish channel verification state",
	}
}

func verificationStateUnavailableAfter() *x402.AfterVerifyResult {
	return &x402.AfterVerifyResult{
		Abort:   true,
		Reason:  batchsettlement.ErrVerificationStateUnavailable,
		Message: "Unable to establish channel verification state",
	}
}

func isNonNegativeIntegerString(value string) bool {
	if value == "" {
		return false
	}
	for _, c := range value {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func paymentRequirementsFromView(v x402.PaymentRequirementsView) types.PaymentRequirements {
	return types.PaymentRequirements{
		Scheme:            v.GetScheme(),
		Network:           v.GetNetwork(),
		Asset:             v.GetAsset(),
		Amount:            v.GetAmount(),
		PayTo:             v.GetPayTo(),
		MaxTimeoutSeconds: v.GetMaxTimeoutSeconds(),
		Extra:             v.GetExtra(),
	}
}

func inferMissingLocalChargedAmount(signedMaxClaimable, price string, isPaidPayload bool) string {
	if !isPaidPayload {
		return signedMaxClaimable
	}
	signed, ok := new(big.Int).SetString(signedMaxClaimable, 10)
	if !ok {
		signed = big.NewInt(0)
	}
	amount, ok := new(big.Int).SetString(price, 10)
	if !ok {
		amount = big.NewInt(0)
	}
	if signed.Cmp(amount) < 0 {
		return "0"
	}
	return new(big.Int).Sub(signed, amount).String()
}

// BeforeVerifyHook runs cheap rejects with no lock, then acquires an admission
// lock, performs one storage.Get, and re-checks the cumulative base under that
// reservation. Local voucher verify may skip the facilitator; otherwise the
// lock is held across facilitator /verify.
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

		if s.enforceMinDeposit && batchsettlement.IsDepositPayload(payload) {
			hintReq := types.PaymentRequirements{
				Amount:  ctx.Requirements.GetAmount(),
				Asset:   ctx.Requirements.GetAsset(),
				Network: ctx.Requirements.GetNetwork(),
				Extra:   ctx.Requirements.GetExtra(),
			}
			minDepositStr, hintErr := s.ResolveMinDepositHint(hintReq)
			if hintErr != nil {
				return nil, hintErr
			}
			minDeposit, ok := new(big.Int).SetString(minDepositStr, 10)
			depositAmount := depositAmountFromPayload(payload)
			if ok && minDeposit != nil && depositAmount != nil && depositAmount.Cmp(minDeposit) < 0 {
				return &x402.BeforeHookResult{
					Abort:   true,
					Reason:  batchsettlement.ErrDepositBelowMinDeposit,
					Message: "Deposit amount is below the server minimum",
				}, nil
			}
		}

		voucherFields, _ := payload["voucher"].(map[string]interface{})
		if voucherFields == nil {
			return nil, nil
		}
		rawChannelId, _ := voucherFields["channelId"].(string)
		signedMaxStr, _ := voucherFields["maxClaimableAmount"].(string)
		signature, _ := voucherFields["signature"].(string)

		cfgMap, _ := payload["channelConfig"].(map[string]interface{})
		cfg, cfgErr := batchsettlement.ChannelConfigFromMap(cfgMap)
		if cfgErr != nil {
			return verificationStateUnavailable(), nil //nolint:nilerr // map storage/parse failures to fail-closed abort
		}

		if bindErr := batchsettlement.ChannelIdBindingError(cfg, rawChannelId, ctx.Requirements.GetNetwork()); bindErr != "" {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  bindErr,
				Message: "Channel id does not match channel config",
			}, nil
		}

		if !isNonNegativeIntegerString(signedMaxStr) ||
			!isNonNegativeIntegerString(ctx.Requirements.GetAmount()) {
			return verificationStateUnavailable(), nil
		}
		if batchsettlement.IsDepositPayload(payload) {
			deposit, _ := payload["deposit"].(map[string]interface{})
			depositAmount, _ := deposit["amount"].(string)
			if !isNonNegativeIntegerString(depositAmount) {
				return verificationStateUnavailable(), nil
			}
		}

		if cfgErr := facilitator.ValidateChannelConfig(cfg, rawChannelId, paymentRequirementsFromView(ctx.Requirements)); cfgErr != nil {
			reason := facilitator.ErrChannelIdMismatch
			var ve *x402.VerifyError
			if errors.As(cfgErr, &ve) && ve.InvalidReason != "" {
				reason = ve.InvalidReason
			}
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  reason,
				Message: "Channel config does not match payment requirements",
			}, nil
		}

		if batchsettlement.IsVoucherPayload(payload) && !strings.EqualFold(cfg.PayerAuthorizer, zeroAddress) {
			vp, parseErr := batchsettlement.VoucherPayloadFromMap(payload)
			if parseErr != nil {
				return verificationStateUnavailable(), nil //nolint:nilerr // map parse failures to fail-closed abort
			}
			if !verifyEoaVoucherSignature(vp, ctx.Requirements.GetNetwork()) {
				return &x402.BeforeHookResult{
					Abort:   true,
					Reason:  facilitator.ErrVoucherSignatureInvalid,
					Message: "Voucher signature is invalid",
				}, nil
			}
		}

		channelId := rawChannelId
		if normalized, err := batchsettlement.NormalizeChannelId(rawChannelId); err == nil {
			channelId = normalized
		}

		now := time.Now().UnixMilli()
		pendingNonce, err := evm.CreateNonce()
		if err != nil {
			return verificationStateUnavailable(), nil //nolint:nilerr // map nonce failures to fail-closed abort
		}
		pendingId := pendingNonce
		s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{
			ChannelId: channelId,
			PendingId: pendingId,
		})

		acquired, acquireErr := s.lockStorage.Acquire(channelId, pendingId, pendingTtlMs(ctx.Requirements.GetMaxTimeoutSeconds()))
		if impl := RethrowLockImplementationError(acquireErr); impl != nil {
			s.TakeRequestContext(ctx.Payload)
			return nil, impl
		}
		if acquireErr == nil {
			if !acquired {
				s.TakeRequestContext(ctx.Payload)
				return &x402.BeforeHookResult{
					Abort:   true,
					Reason:  batchsettlement.ErrChannelBusy,
					Message: "Channel is already processing a request",
				}, nil
			}
			s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{ReservationCommitted: reservationFlag(true)})
		}

		channelSnapshot, getErr := s.storage.Get(channelId)
		if getErr != nil {
			_ = s.ClearPendingRequest(ctx.Payload)
			return verificationStateUnavailable(), nil //nolint:nilerr // map storage failures to fail-closed abort
		}

		chargedCumulativeAmount := inferMissingLocalChargedAmount(signedMaxStr, ctx.Requirements.GetAmount(), isPaid)
		if channelSnapshot != nil {
			chargedCumulativeAmount = channelSnapshot.ChargedCumulativeAmount
		}

		prevCharged, _ := new(big.Int).SetString(chargedCumulativeAmount, 10)
		if prevCharged == nil {
			prevCharged = big.NewInt(0)
		}
		reqAmount, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
		if reqAmount == nil {
			reqAmount = big.NewInt(0)
		}
		signedMax, _ := new(big.Int).SetString(signedMaxStr, 10)
		if signedMax == nil {
			signedMax = big.NewInt(0)
		}

		var expectedMax *big.Int
		if isZeroCharge {
			expectedMax = new(big.Int).Set(prevCharged)
		} else {
			expectedMax = new(big.Int).Add(prevCharged, reqAmount)
		}

		if signedMax.Cmp(expectedMax) != 0 {
			snapshot := channelSnapshot
			if snapshot == nil {
				snapshot = buildProvisionalChannelFromPayload(
					channelId, signedMaxStr, signature, payload, prevCharged.String(), now,
				)
			}
			s.RememberChannelSnapshot(ctx.Payload, snapshot)
			_ = s.ReleasePendingRequest(ctx.Payload)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batchsettlement.ErrCumulativeAmountMismatch,
				Message: "Client voucher base does not match server state",
			}, nil
		}

		s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{ChannelSnapshot: channelSnapshot})

		if batchsettlement.IsVoucherPayload(payload) {
			localResult := s.evaluateVoucherAgainstCachedState(ctx.Requirements, payload, channelSnapshot, now)
			if localResult != nil {
				if !localResult.IsValid {
					_ = s.ClearPendingRequest(ctx.Payload)
					return &x402.BeforeHookResult{
						Skip:             true,
						SkipVerifyResult: localResult,
					}, nil
				}
				s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{LocalVerify: true})
				return &x402.BeforeHookResult{
					Skip:             true,
					SkipVerifyResult: localResult,
				}, nil
			}
		}
		return nil, nil
	}
}

// evaluateVoucherAgainstCachedState returns a successful VerifyResponse when the
// voucher can be verified entirely against locally cached channel state — i.e.
// the cache is within the configured TTL of last onchain sync, the channel
// config validates, the recomputed channelId matches, and balance/claimed
// bounds hold. EOA signature validity is enforced earlier in BeforeVerify.
// Returns nil on any check that requires falling back to the facilitator, and
// an explicit invalid VerifyResponse when a local check fails.
//
// The smart-wallet (ERC-1271) path is intentionally not supported — vouchers
// signed by a non-zero EOA payerAuthorizer are the only candidates.
func (s *BatchSettlementEvmScheme) evaluateVoucherAgainstCachedState(
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

	if cfgErr := facilitator.ValidateChannelConfig(vp.ChannelConfig, vp.Voucher.ChannelId, paymentRequirementsFromView(requirements)); cfgErr != nil {
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

// verifyEoaVoucherSignature verifies an EOA voucher via ecrecover, matching
// x402BatchSettlement._processVoucherClaim. It does not need a channel row.
func verifyEoaVoucherSignature(vp *batchsettlement.BatchSettlementVoucherPayload, network string) bool {
	chainID, err := evm.GetEvmChainId(network)
	if err != nil {
		return false
	}
	maxClaimable, ok := new(big.Int).SetString(vp.Voucher.MaxClaimableAmount, 10)
	if !ok {
		return false
	}
	hash, err := evm.HashTypedData(
		batchsettlement.GetBatchSettlementEip712Domain(chainID),
		batchsettlement.VoucherTypes,
		"Voucher",
		map[string]interface{}{
			"channelId":          vp.Voucher.ChannelId,
			"maxClaimableAmount": maxClaimable,
		},
	)
	if err != nil {
		return false
	}
	ok, err = evm.VerifyEOASignature(
		hash, common.FromHex(vp.Voucher.Signature), common.HexToAddress(vp.ChannelConfig.PayerAuthorizer),
	)
	return err == nil && ok
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

// AfterVerifyHook stashes facilitator extras on the request snapshot.
// Admission is reserved in BeforeVerifyHook; this hook does not acquire
// and does not read storage.
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
			return nil, nil
		}

		payload := ctx.Payload.GetPayload()

		var channelId, signedMaxClaimable, signature string
		var channelConfig batchsettlement.ChannelConfig
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
			channelConfig = dp.ChannelConfig
		case batchsettlement.IsVoucherPayload(payload):
			vp, parseErr := batchsettlement.VoucherPayloadFromMap(payload)
			if parseErr != nil {
				return nil, nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = vp.Voucher.ChannelId
			signedMaxClaimable = vp.Voucher.MaxClaimableAmount
			signature = vp.Voucher.Signature
			channelConfig = vp.ChannelConfig
		case batchsettlement.IsRefundPayload(payload):
			rp, parseErr := batchsettlement.RefundPayloadFromMap(payload)
			if parseErr != nil {
				return nil, nil //nolint:nilerr // parse failure in after-hook is non-fatal
			}
			channelId = rp.Voucher.ChannelId
			signedMaxClaimable = rp.Voucher.MaxClaimableAmount
			signature = rp.Voucher.Signature
			channelConfig = rp.ChannelConfig
			isRefundVoucher = true
		default:
			return nil, nil
		}

		normalizedId, normErr := batchsettlement.NormalizeChannelId(channelId)
		if normErr != nil {
			return verificationStateUnavailableAfter(), nil //nolint:nilerr // map invalid ids to fail-closed abort
		}

		rc := s.ReadRequestContext(ctx.Payload)
		if rc == nil || rc.PendingId == "" {
			return verificationStateUnavailableAfter(), nil
		}
		localVerify := rc.LocalVerify
		now := time.Now().UnixMilli()

		ex := ctx.Result.Extra
		prior := rc.ChannelSnapshot
		base := inferMissingLocalChargedAmount(signedMaxClaimable, ctx.Requirements.GetAmount(), !isRefundVoucher)
		if prior != nil {
			base = prior.ChargedCumulativeAmount
		}

		onchainSyncedAt := now
		if localVerify && prior != nil {
			onchainSyncedAt = prior.OnchainSyncedAt
		}

		channelSnapshot := &ChannelSession{
			ChannelId:               normalizedId,
			ChannelConfig:           channelConfig,
			ChargedCumulativeAmount: base,
			SignedMaxClaimable:      signedMaxClaimable,
			Signature:               signature,
			Balance:                 mapStringField(ex, "balance", "0"),
			TotalClaimed:            mapStringField(ex, "totalClaimed", "0"),
			WithdrawRequestedAt:     mapIntField(ex, "withdrawRequestedAt", 0),
			RefundNonce:             mapIntField(ex, "refundNonce", 0),
			OnchainSyncedAt:         onchainSyncedAt,
			LastRequestTimestamp:    now,
		}

		s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{ChannelSnapshot: channelSnapshot})

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
//
// Refund and deposit payloads pass through to facilitator settlement; their
// durable rows update in AfterSettleHook.
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

		increment, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
		if increment == nil {
			increment = big.NewInt(0)
		}
		maxClaimable, _ := voucherMap["maxClaimableAmount"].(string)
		sig, _ := voucherMap["signature"].(string)
		rc := s.ReadRequestContext(ctx.Payload)
		var snapshot *ChannelSession
		var pendingId string
		localVerify := false
		if rc != nil {
			snapshot = rc.ChannelSnapshot
			pendingId = rc.PendingId
			localVerify = rc.LocalVerify
		}
		now := time.Now().UnixMilli()

		var (
			outcome             string // "missing" | "cap_exceeded" | "committed"
			capExceededAmount   string
			committedPrev       *ChannelSession
			committedNew        *ChannelSession
			committedNewCharged *big.Int
		)

		chargeUpdate := func(useSnapshot bool) (*ChannelUpdateResult, error) {
			outcome = ""
			capExceededAmount = ""
			committedPrev = nil
			committedNew = nil
			committedNewCharged = nil
			return s.storage.UpdateChannel(channelId, func(current *ChannelSession) *ChannelSession {
				base := current
				if base == nil && useSnapshot {
					base = snapshot
				}
				if base == nil {
					outcome = "missing"
					return current
				}
				curCharged, _ := new(big.Int).SetString(base.ChargedCumulativeAmount, 10)
				if curCharged == nil {
					curCharged = big.NewInt(0)
				}
				next := new(big.Int).Add(curCharged, increment)
				cap2, _ := new(big.Int).SetString(maxClaimable, 10)
				if cap2 != nil && next.Cmp(cap2) > 0 {
					outcome = "cap_exceeded"
					capExceededAmount = next.String()
					return current
				}
				updated := *base
				if !localVerify && snapshot != nil {
					updated.Balance = snapshot.Balance
					updated.TotalClaimed = snapshot.TotalClaimed
					updated.WithdrawRequestedAt = snapshot.WithdrawRequestedAt
					updated.RefundNonce = snapshot.RefundNonce
					updated.OnchainSyncedAt = now
				}
				updated.ChargedCumulativeAmount = next.String()
				updated.SignedMaxClaimable = maxClaimable
				updated.Signature = sig
				updated.LastRequestTimestamp = now
				outcome = "committed"
				committedPrev = base
				committedNew = &updated
				committedNewCharged = next
				return &updated
			})
		}

		updateRes, updateErr := chargeUpdate(false)
		if updateErr != nil {
			return nil, updateErr
		}
		if outcome == "missing" && snapshot != nil {
			hold, holdErr := inspectAdmission(s, channelId, pendingId)
			if holdErr != nil {
				return nil, holdErr
			}
			switch hold {
			case admissionOther:
				return &x402.BeforeHookResult{
					Abort:   true,
					Reason:  batchsettlement.ErrChannelBusy,
					Message: "Concurrent request holds channel admission lock",
				}, nil
			case admissionSelf:
				updateRes, updateErr = chargeUpdate(true)
				if updateErr != nil {
					return nil, updateErr
				}
			}
		}

		_ = s.ClearPendingRequest(ctx.Payload)

		switch outcome {
		case "missing":
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batchsettlement.ErrMissingChannel,
				Message: "No channel record",
			}, nil
		case "cap_exceeded":
			capStr := maxClaimable
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batchsettlement.ErrChargeExceedsSignedCumulative,
				Message: fmt.Sprintf("Charged %s exceeds signed max %s", capExceededAmount, capStr),
			}, nil
		}

		if updateRes.Status != ChannelUpdated || outcome != "committed" {
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batchsettlement.ErrChannelBusy,
				Message: "Concurrent request modified channel state",
			}, nil
		}

		// Emit the nested response shape: chargedAmount + channelState.
		skipExtra := &batchsettlement.BatchSettlementPaymentResponseExtra{
			ChargedAmount: ctx.Requirements.GetAmount(),
			ChannelState: &batchsettlement.BatchSettlementChannelStateExtra{
				ChannelId:               channelId,
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

	requestContext := s.ReadRequestContext(ctx.Payload)
	var snapshot *ChannelSession
	var pendingId string
	if requestContext != nil {
		snapshot = requestContext.ChannelSnapshot
		pendingId = requestContext.PendingId
	}
	stored, storageErr := s.storage.Get(channelIdStr)
	if storageErr != nil {
		return nil, storageErr
	}
	hold, holdErr := inspectAdmission(s, channelIdStr, pendingId)
	if holdErr != nil {
		return nil, holdErr
	}
	if stored == nil && snapshot != nil && hold != admissionSelf {
		return nil, errors.New(batchsettlement.ErrMissingChannel)
	}
	if hold == admissionOther {
		return nil, errors.New(batchsettlement.ErrChannelBusy)
	}
	var session *ChannelSession
	if snapshot != nil {
		merged := *snapshot
		if stored != nil {
			merged.ChargedCumulativeAmount = stored.ChargedCumulativeAmount
		}
		session = &merged
	} else {
		session = stored
	}
	if session == nil {
		return nil, errors.New(batchsettlement.ErrMissingChannel)
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
		authSig, err := s.SignRefund(context.Background(), channelIdStr, refundAmount.String(), nonce, network)
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
			normalizedId := dp.Voucher.ChannelId
			rc := s.ReadRequestContext(ctx.Payload)
			var pendingId string
			if rc != nil {
				pendingId = rc.PendingId
			}

			cs := readChannelStateFromExtra(ctx.Result.Extra)
			now := time.Now().UnixMilli()
			reqAmount, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
			if reqAmount == nil {
				reqAmount = big.NewInt(0)
			}

			hold, holdErr := inspectAdmission(s, normalizedId, pendingId)
			if holdErr != nil {
				return holdErr
			}
			if hold == admissionOther {
				return errors.New(batchsettlement.ErrChannelBusy)
			}
			var recovered *ChannelSession
			if rc != nil {
				recovered = rc.ChannelSnapshot
			}

			updateRes, updateErr := s.storage.UpdateChannel(normalizedId, func(current *ChannelSession) *ChannelSession {
				existing := current
				if existing == nil && hold == admissionSelf {
					existing = recovered
				}
				if existing == nil {
					return current
				}
				curCharged, _ := new(big.Int).SetString(existing.ChargedCumulativeAmount, 10)
				if curCharged == nil {
					curCharged = big.NewInt(0)
				}
				next := *existing
				next.ChannelId = normalizedId
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
				return &next
			})
			if updateErr != nil {
				return updateErr
			}
			if updateRes.Status == ChannelUpdated && updateRes.Channel != nil {
				s.RememberChannelSnapshot(ctx.Payload, updateRes.Channel)
				_ = s.ReleasePendingRequest(ctx.Payload)
				return nil
			}
			return errors.New(batchsettlement.ErrChannelBusy)
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
			normalizedId := channelId
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
			hold, holdErr := inspectAdmission(s, normalizedId, pendingId)
			if holdErr != nil {
				return holdErr
			}
			if hold == admissionOther {
				return errors.New(batchsettlement.ErrChannelBusy)
			}
			var recovered *ChannelSession
			if rc != nil {
				recovered = rc.ChannelSnapshot
			}

			updateRes, updateErr := s.storage.UpdateChannel(normalizedId, func(current *ChannelSession) *ChannelSession {
				existing := current
				if existing == nil && hold == admissionSelf {
					existing = recovered
				}
				if existing == nil {
					return current
				}
				postBalance, _ := new(big.Int).SetString(snapshot.Balance, 10)
				if postBalance == nil {
					postBalance = big.NewInt(0)
				}
				curCharged, _ := new(big.Int).SetString(existing.ChargedCumulativeAmount, 10)
				if curCharged == nil {
					curCharged = big.NewInt(0)
				}
				if postBalance.Cmp(curCharged) <= 0 {
					return nil
				}
				next := *existing
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
				return &next
			})
			if updateErr != nil {
				return updateErr
			}
			if updateRes.Status == ChannelUnchanged {
				return errors.New(batchsettlement.ErrChannelBusy)
			}
			_ = s.ReleasePendingRequest(ctx.Payload)
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

func depositAmountFromPayload(payload map[string]interface{}) *big.Int {
	if payload == nil {
		return nil
	}
	dep, ok := payload["deposit"].(map[string]interface{})
	if !ok {
		return nil
	}
	s, ok := dep["amount"].(string)
	if !ok {
		return nil
	}
	n, ok := new(big.Int).SetString(s, 10)
	if !ok {
		return nil
	}
	return n
}
