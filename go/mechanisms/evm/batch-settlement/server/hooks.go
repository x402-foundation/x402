package server

import (
	"context"
	"errors"
	"fmt"
	"log"
	"math"
	"math/big"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/common"
	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm"
	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/facilitator"
	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
	"github.com/x402-foundation/x402/go/v2/types"
)

const zeroAddress = "0x0000000000000000000000000000000000000000"

// Pending reservation TTL bounds. Cleanup hooks normally release admission
// locks on failure; these bounds release the channel if cleanup never runs.
type admissionHold int

const (
	admissionSelf admissionHold = iota
	admissionOther
	admissionNone
)

// inspectAdmission classifies whether this request still holds the admission
// lock, another request holds it, or no lock is present (lost/expired or lock
// store I/O down). Implementation/parse errors fail closed.
func inspectAdmission(ctx context.Context, scheme *BatchSettlementEvmScheme, channelId, pendingId string) (admissionHold, error) {
	locks := scheme.GetLockStorage()
	if pendingId != "" {
		held, err := locks.IsHeld(ctx, channelId, pendingId)
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
	held, err := locks.IsHeld(ctx, channelId, "")
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

// AbortIfBelowMinDeposit rejects a deposit below extra.minDeposit when enforcement is on.
func AbortIfBelowMinDeposit(scheme *BatchSettlementEvmScheme, raw map[string]interface{}, requirements x402.PaymentRequirementsView) (*x402.BeforeHookResult, error) {
	if !scheme.GetEnforceMinDeposit() || !batchsettlement.IsDepositPayload(raw) {
		return nil, nil
	}
	hintReq := types.PaymentRequirements{
		Amount:  requirements.GetAmount(),
		Asset:   requirements.GetAsset(),
		Network: requirements.GetNetwork(),
		Extra:   requirements.GetExtra(),
	}
	minDepositStr, hintErr := scheme.ResolveMinDepositHint(hintReq)
	if hintErr != nil {
		return nil, hintErr
	}
	minDeposit, ok := new(big.Int).SetString(minDepositStr, 10)
	depositAmount := depositAmountFromPayload(raw)
	if ok && minDeposit != nil && depositAmount != nil && depositAmount.Cmp(minDeposit) < 0 {
		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  batchsettlement.ErrDepositBelowMinDeposit,
			Message: "Deposit amount is below the server minimum",
		}, nil
	}
	return nil, nil
}

// AbortIfUnexpectedPendingId rejects a client-supplied pendingId. Reservations are server-authored.
func AbortIfUnexpectedPendingId(raw map[string]interface{}) *x402.BeforeHookResult {
	if _, ok := raw["pendingId"]; !ok {
		return nil
	}
	return &x402.BeforeHookResult{
		Abort:   true,
		Reason:  batchsettlement.ErrUnexpectedPendingId,
		Message: "pendingId is server-authored and must not be supplied by the client",
	}
}

// AbortIfUnexpectedCancel rejects a client-supplied cancel flag. Cancel settle is server-authored.
func AbortIfUnexpectedCancel(raw map[string]interface{}) *x402.BeforeHookResult {
	if _, ok := raw["cancel"]; !ok {
		return nil
	}
	return &x402.BeforeHookResult{
		Abort:   true,
		Reason:  batchsettlement.ErrUnexpectedCancel,
		Message: "cancel is server-authored and must not be supplied by the client",
	}
}

// AbortIfUnexpectedServerAuthoredSettleFields rejects client-supplied pendingId or cancel.
func AbortIfUnexpectedServerAuthoredSettleFields(raw map[string]interface{}) *x402.BeforeHookResult {
	if abort := AbortIfUnexpectedPendingId(raw); abort != nil {
		return abort
	}
	return AbortIfUnexpectedCancel(raw)
}

// AbortIfChannelUnbound rejects a claimed channel id that does not match channelConfig.
func AbortIfChannelUnbound(raw map[string]interface{}, network string) *x402.BeforeHookResult {
	cfgMap, _ := raw["channelConfig"].(map[string]interface{})
	cfg, err := batchsettlement.ChannelConfigFromMap(cfgMap)
	if err != nil {
		return verificationStateUnavailable()
	}
	voucherFields, _ := raw["voucher"].(map[string]interface{})
	rawChannelId, _ := voucherFields["channelId"].(string)
	if bindErr := batchsettlement.ChannelIdBindingError(cfg, rawChannelId, network); bindErr != "" {
		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  bindErr,
			Message: "Channel id does not match channel config",
		}
	}
	return nil
}

// SkipHandlerForRefund is the resource-handler skip used after a verified refund.
func SkipHandlerForRefund(channelId string) *x402.AfterVerifyResult {
	return &x402.AfterVerifyResult{
		SkipHandler: true,
		Response: &x402.SkipHandlerDirective{
			ContentType: "application/json",
			Body: map[string]interface{}{
				"message":   "Refund acknowledged",
				"channelId": channelId,
			},
		},
	}
}

// WriteCorrectiveAcceptExtra copies corrective channel and voucher snapshots onto a 402 accept.
func WriteCorrectiveAcceptExtra(
	accept *types.PaymentRequirements,
	channelState batchsettlement.BatchSettlementChannelStateExtra,
	voucherState batchsettlement.BatchSettlementVoucherStateExtra,
) {
	if accept.Extra == nil {
		accept.Extra = make(map[string]interface{})
	}
	accept.Extra["channelState"] = channelState.ToMap()
	if voucherMap := voucherState.ToMap(); voucherMap != nil {
		accept.Extra["voucherState"] = voucherMap
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

// BeforeVerifyHook runs cheap rejects with no lock, then acquires an admission
// lock, performs one storage.Get, and re-checks the cumulative base under that
// reservation. Local voucher verify may skip the facilitator; otherwise the
// lock is held across facilitator /verify.
func (s *BatchSettlementEvmScheme) BeforeVerifyHook() x402.BeforeVerifyHook {
	return func(ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil, nil
		}
		if !s.handlersMatch(ctx.Requirements) {
			return voucherStoreModeMismatchAbort(), nil
		}
		if s.configuredMode == VoucherStoreModeFacilitator {
			return handleManagedBeforeVerify(s, ctx)
		}
		return handleBeforeVerify(s, ctx)
	}
}

func handleBeforeVerify(s *BatchSettlementEvmScheme, ctx x402.VerifyContext) (*x402.BeforeHookResult, error) {
	payload := ctx.Payload.GetPayload()

	isPaid := batchsettlement.IsVoucherPayload(payload) || batchsettlement.IsDepositPayload(payload)
	isZeroCharge := batchsettlement.IsRefundPayload(payload)
	if !isPaid && !isZeroCharge {
		return nil, nil
	}

	if serverFieldAbort := AbortIfUnexpectedServerAuthoredSettleFields(payload); serverFieldAbort != nil {
		return serverFieldAbort, nil
	}

	minDepositAbort, hintErr := AbortIfBelowMinDeposit(s, payload, ctx.Requirements)
	if hintErr != nil {
		return nil, hintErr
	}
	if minDepositAbort != nil {
		return minDepositAbort, nil
	}

	voucherFields, _ := payload["voucher"].(map[string]interface{})
	if voucherFields == nil {
		return nil, nil
	}
	rawChannelId, _ := voucherFields["channelId"].(string)
	signedMaxStr, _ := voucherFields["maxClaimableAmount"].(string)

	if bindAbort := AbortIfChannelUnbound(payload, ctx.Requirements.GetNetwork()); bindAbort != nil {
		return bindAbort, nil
	}

	cfgMap, _ := payload["channelConfig"].(map[string]interface{})
	cfg, cfgErr := batchsettlement.ChannelConfigFromMap(cfgMap)
	if cfgErr != nil {
		return verificationStateUnavailable(), nil //nolint:nilerr // map storage/parse failures to fail-closed abort
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

	acquired, acquireErr := s.lockStorage.Acquire(ctx.Ctx, channelId, pendingId, storage.PendingTtlMs(ctx.Requirements.GetMaxTimeoutSeconds()))
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

	channelSnapshot, getErr := s.storage.Get(ctx.Ctx, channelId)
	if getErr != nil {
		_ = s.ClearPendingRequest(ctx.Payload)
		return verificationStateUnavailable(), nil //nolint:nilerr // map storage failures to fail-closed abort
	}

	// With no local record the baseline is the facilitator-verified onchain
	// totalClaimed, which is only known in AfterVerify; the cumulative check runs there.
	if channelSnapshot != nil {
		prevCharged, _ := new(big.Int).SetString(channelSnapshot.ChargedCumulativeAmount, 10)
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

		expectedMax := new(big.Int).Set(prevCharged)
		if !isZeroCharge {
			expectedMax.Add(expectedMax, reqAmount)
		}

		if signedMax.Cmp(expectedMax) != 0 {
			s.RememberChannelSnapshot(ctx.Payload, channelSnapshot)
			_ = s.ReleasePendingRequest(ctx.Payload)
			return &x402.BeforeHookResult{
				Abort:   true,
				Reason:  batchsettlement.ErrCumulativeAmountMismatch,
				Message: "Client voucher base does not match server state",
			}, nil
		}
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
		if !s.handlersMatch(ctx.Requirements) {
			return voucherStoreModeMismatchAbortAfter(), nil
		}
		if s.configuredMode == VoucherStoreModeFacilitator {
			return handleManagedAfterVerify(s, ctx)
		}
		return handleAfterVerify(s, ctx)
	}
}

func voucherStoreModeMismatchAbortAfter() *x402.AfterVerifyResult {
	return &x402.AfterVerifyResult{
		Abort:   true,
		Reason:  batchsettlement.ErrVoucherStoreModeMismatch,
		Message: "Payment requirements voucherManager does not match the server voucherStoreMode",
	}
}

func handleAfterVerify(s *BatchSettlementEvmScheme, ctx x402.VerifyResultContext) (*x402.AfterVerifyResult, error) {
	if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
		return nil, nil
	}
	if ctx.Result != nil && !ctx.Result.IsValid {
		// A structured facilitator rejection does not run OnVerifyFailure, so release the BeforeVerify admission lock here.
		return nil, s.ClearPendingRequest(ctx.Payload)
	}
	if ctx.Result == nil || ctx.Result.Payer == "" {
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
	balance := mapStringField(ex, "balance", "0")
	totalClaimed, ok := mapUintStringField(ex, "totalClaimed")
	if !ok {
		return verificationStateUnavailableAfter(), nil
	}
	withdrawRequestedAt := mapIntField(ex, "withdrawRequestedAt", 0)
	refundNonce := mapIntField(ex, "refundNonce", 0)

	// With no local record the baseline is the facilitator-verified onchain
	// totalClaimed, never a value derived from the payer-signed voucher.
	prior := rc.ChannelSnapshot
	base := totalClaimed
	if prior != nil {
		base = prior.ChargedCumulativeAmount
	}
	baseAmt, _ := new(big.Int).SetString(base, 10)
	if baseAmt == nil {
		baseAmt = big.NewInt(0)
	}
	reqAmount, _ := new(big.Int).SetString(ctx.Requirements.GetAmount(), 10)
	if reqAmount == nil {
		reqAmount = big.NewInt(0)
	}
	signedMax, _ := new(big.Int).SetString(signedMaxClaimable, 10)
	if signedMax == nil {
		signedMax = big.NewInt(0)
	}
	expectedMax := new(big.Int).Set(baseAmt)
	if !isRefundVoucher {
		expectedMax.Add(expectedMax, reqAmount)
	}
	if signedMax.Cmp(expectedMax) != 0 {
		stale := prior
		if stale == nil {
			stale = buildProvisionalChannelFromPayload(
				normalizedId, signedMaxClaimable, signature, payload, base, now,
			)
			stale.Balance = balance
			stale.TotalClaimed = totalClaimed
			stale.WithdrawRequestedAt = withdrawRequestedAt
			stale.RefundNonce = refundNonce
		}
		s.RememberChannelSnapshot(ctx.Payload, stale)
		_ = s.ReleasePendingRequest(ctx.Payload)
		return &x402.AfterVerifyResult{
			Abort:   true,
			Reason:  batchsettlement.ErrCumulativeAmountMismatch,
			Message: "Client voucher base does not match server state",
		}, nil
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
		Balance:                 balance,
		TotalClaimed:            totalClaimed,
		WithdrawRequestedAt:     withdrawRequestedAt,
		RefundNonce:             refundNonce,
		OnchainSyncedAt:         onchainSyncedAt,
		LastRequestTimestamp:    now,
	}

	s.MergeRequestContext(ctx.Payload, BatchSettlementRequestContext{ChannelSnapshot: channelSnapshot})

	if isRefundVoucher {
		return SkipHandlerForRefund(normalizedId), nil
	}
	return nil, nil
}

// OnVerifyFailureHook releases a reservation when facilitator verification fails.
func (s *BatchSettlementEvmScheme) OnVerifyFailureHook() x402.OnVerifyFailureHook {
	return func(ctx x402.VerifyFailureContext) (*x402.VerifyFailureHookResult, error) {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil, nil
		}
		if !s.handlersMatch(ctx.Requirements) {
			return nil, nil
		}
		if s.configuredMode == VoucherStoreModeFacilitator {
			return handleManagedVerifyFailure(s, ctx)
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
		if !s.handlersMatch(ctx.Requirements) {
			return voucherStoreModeMismatchAbort(), nil
		}
		if s.configuredMode == VoucherStoreModeFacilitator {
			return handleManagedBeforeSettle(s, ctx)
		}
		return handleBeforeSettle(s, ctx)
	}
}

func handleBeforeSettle(s *BatchSettlementEvmScheme, ctx x402.SettleContext) (*x402.BeforeHookResult, error) {
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
	signedCap, _ := new(big.Int).SetString(maxClaimable, 10)
	if signedCap == nil {
		signedCap = big.NewInt(0)
	}
	recoverFromSnapshot := false
	voucher := batchsettlement.BatchSettlementVoucherFields{
		ChannelId:          channelId,
		MaxClaimableAmount: maxClaimable,
		Signature:          sig,
	}

	outcome, err := storage.CommitVoucherCharge(ctx.Ctx, s.GetStorage(), channelId, storage.CommitVoucherChargeInput[*ChannelSession]{
		Increment:           increment,
		SignedCap:           signedCap,
		Voucher:             voucher,
		Snapshot:            snapshot,
		RecoverFromSnapshot: &recoverFromSnapshot,
		Now:                 now,
		LocalVerify:         localVerify,
	})
	if err != nil {
		return nil, err
	}
	if outcome.Status == storage.CommitMissing && snapshot != nil {
		hold, holdErr := inspectAdmission(ctx.Ctx, s, channelId, pendingId)
		if holdErr != nil {
			return nil, holdErr
		}
		if hold == admissionSelf {
			outcome, err = storage.CommitVoucherCharge(ctx.Ctx, s.GetStorage(), channelId, storage.CommitVoucherChargeInput[*ChannelSession]{
				Increment:   increment,
				SignedCap:   signedCap,
				Voucher:     voucher,
				Snapshot:    snapshot,
				Now:         now,
				LocalVerify: localVerify,
			})
			if err != nil {
				return nil, err
			}
		}
	}

	_ = s.ClearPendingRequest(ctx.Payload)

	switch outcome.Status {
	case storage.CommitMissing:
		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  batchsettlement.ErrMissingChannel,
			Message: "No channel record",
		}, nil
	case storage.CommitCapExceeded:
		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  batchsettlement.ErrChargeExceedsSignedCumulative,
			Message: fmt.Sprintf("Charged %s exceeds signed max %s", outcome.Charged, signedCap.String()),
		}, nil
	case storage.CommitWatermarkMismatch:
		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  batchsettlement.ErrCumulativeAmountMismatch,
			Message: "Charged amount does not match the verified watermark",
		}, nil
	case storage.CommitCommitted:
		charged := outcome.Current.ChargedCumulativeAmount
		reqAmount := ctx.Requirements.GetAmount()
		skipExtra := storage.PaymentResponseExtra(
			storage.ChannelStateExtra(outcome.Current, &charged),
			&reqAmount,
			nil,
		)
		return &x402.BeforeHookResult{
			Skip: true,
			SkipResult: &x402.SettleResponse{
				Success:     true,
				Transaction: "",
				Network:     x402.Network(ctx.Requirements.GetNetwork()),
				Payer:       strings.ToLower(outcome.Previous.ChannelConfig.Payer),
				Amount:      "",
				Extra:       skipExtra.ToMap(),
			},
		}, nil
	case storage.CommitConflict:
		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  batchsettlement.ErrChannelBusy,
			Message: "Concurrent request modified channel state",
		}, nil
	default:
		return &x402.BeforeHookResult{
			Abort:   true,
			Reason:  batchsettlement.ErrChannelBusy,
			Message: "Concurrent request modified channel state",
		}, nil
	}
}

// OnSettleFailureHook releases a reservation when facilitator settlement fails.
func (s *BatchSettlementEvmScheme) OnSettleFailureHook() x402.OnSettleFailureHook {
	return func(ctx x402.SettleFailureContext) (*x402.SettleFailureHookResult, error) {
		if ctx.Requirements.GetScheme() != batchsettlement.SchemeBatched {
			return nil, nil
		}
		if !s.handlersMatch(ctx.Requirements) {
			return nil, nil
		}
		if s.configuredMode == VoucherStoreModeFacilitator {
			return handleManagedSettleFailure(s, ctx)
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
	if err := s.requireHandlers(ctx.Requirements); err != nil {
		return nil, err
	}
	if s.configuredMode == VoucherStoreModeFacilitator {
		return handleManagedEnrichSettlementPayload(s, ctx)
	}
	return handleEnrichSettlementPayload(s, ctx)
}

func handleEnrichSettlementPayload(s *BatchSettlementEvmScheme, ctx x402.SettleContext) (map[string]interface{}, error) {
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
	stored, storageErr := s.storage.Get(ctx.Ctx, channelIdStr)
	if storageErr != nil {
		return nil, storageErr
	}
	hold, holdErr := inspectAdmission(ctx.Ctx, s, channelIdStr, pendingId)
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

	requestedStr, _ := payload["amount"].(string)
	if requestedStr != "" {
		balance, _ := new(big.Int).SetString(session.Balance, 10)
		if balance == nil {
			balance = big.NewInt(0)
		}
		chargedAmt, _ := new(big.Int).SetString(session.ChargedCumulativeAmount, 10)
		if chargedAmt == nil {
			chargedAmt = big.NewInt(0)
		}
		remainder := new(big.Int).Sub(balance, chargedAmt)
		requested, ok := new(big.Int).SetString(requestedStr, 10)
		if ok && requested.Sign() > 0 && requested.Cmp(remainder) > 0 {
			return nil, errors.New(batchsettlement.ErrRefundAmountExceedsBalance)
		}
	}

	enrichment, err := BuildRefundSettlementFields(RefundSettlementFields{
		Ctx:                             ctx.Ctx,
		Channel:                         session,
		ChannelConfig:                   session.ChannelConfig,
		MaxClaimableAmount:              maxClaimable,
		Signature:                       sig,
		Amount:                          requestedStr,
		ChannelId:                       channelIdStr,
		Network:                         ctx.Requirements.GetNetwork(),
		RefundSigner:                    s.GetRefundAuthorizerSigner(),
		IncludeClaimAuthorizerSignature: true,
	})
	if err != nil {
		return nil, err
	}

	s.RememberChannelSnapshot(ctx.Payload, session)
	return enrichment, nil
}

// RefundSettlementFields is the input for BuildRefundSettlementFields.
type RefundSettlementFields struct {
	Ctx                             context.Context
	Channel                         *ChannelSession
	ChannelConfig                   batchsettlement.ChannelConfig
	MaxClaimableAmount              string
	Signature                       string
	Amount                          string
	ChannelId                       string
	Network                         string
	RefundSigner                    AuthorizerSigner
	IncludeClaimAuthorizerSignature bool
}

// BuildRefundSettlementFields builds additive refund settle fields from a channel snapshot.
func BuildRefundSettlementFields(opts RefundSettlementFields) (map[string]interface{}, error) {
	if opts.Channel == nil {
		return nil, errors.New(batchsettlement.ErrMissingChannel)
	}
	claimEntry := batchsettlement.BatchSettlementVoucherClaim{
		Voucher: struct {
			Channel            batchsettlement.ChannelConfig `json:"channel"`
			MaxClaimableAmount string                        `json:"maxClaimableAmount"`
		}{
			Channel:            opts.ChannelConfig,
			MaxClaimableAmount: opts.MaxClaimableAmount,
		},
		Signature:    opts.Signature,
		TotalClaimed: opts.Channel.ChargedCumulativeAmount,
	}

	balance, _ := new(big.Int).SetString(opts.Channel.Balance, 10)
	if balance == nil {
		balance = big.NewInt(0)
	}
	charged, _ := new(big.Int).SetString(opts.Channel.ChargedCumulativeAmount, 10)
	if charged == nil {
		charged = big.NewInt(0)
	}
	remainder := new(big.Int).Sub(balance, charged)
	if remainder.Sign() <= 0 {
		return nil, errors.New(batchsettlement.ErrRefundNoBalance)
	}

	refundAmount := new(big.Int).Set(remainder)
	hasRequestedAmount := opts.Amount != ""
	if hasRequestedAmount {
		if !isNonNegativeIntegerString(opts.Amount) {
			return nil, errors.New(batchsettlement.ErrRefundAmountInvalid)
		}
		requested, ok := new(big.Int).SetString(opts.Amount, 10)
		if !ok || requested.Sign() <= 0 {
			return nil, errors.New(batchsettlement.ErrRefundAmountInvalid)
		}
		refundAmount = requested
	}

	nonce := fmt.Sprintf("%d", opts.Channel.RefundNonce)
	enrichment := map[string]interface{}{
		"refundNonce": nonce,
		"claims":      []batchsettlement.BatchSettlementVoucherClaim{claimEntry},
	}
	if !hasRequestedAmount {
		enrichment["amount"] = refundAmount.String()
	}

	if opts.RefundSigner != nil {
		signCtx := opts.Ctx
		if signCtx == nil {
			signCtx = context.Background()
		}
		authSig, err := signRefundWith(signCtx, opts.RefundSigner, opts.ChannelId, refundAmount.String(), nonce, opts.Network)
		if err != nil {
			return nil, fmt.Errorf("failed to sign refund: %w", err)
		}
		enrichment["refundAuthorizerSignature"] = evm.BytesToHex(authSig)
		if opts.IncludeClaimAuthorizerSignature {
			claimAuthSig, err := signClaimBatchWith(signCtx, opts.RefundSigner, []batchsettlement.BatchSettlementVoucherClaim{claimEntry}, opts.Network)
			if err != nil {
				return nil, fmt.Errorf("failed to sign claim batch for refund: %w", err)
			}
			enrichment["claimAuthorizerSignature"] = evm.BytesToHex(claimAuthSig)
		}
	}

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
		if !s.handlersMatch(ctx.Requirements) {
			return nil
		}
		if s.configuredMode == VoucherStoreModeFacilitator {
			return handleManagedAfterSettle(s, ctx)
		}
		return handleAfterSettle(s, ctx)
	}
}

func handleAfterSettle(s *BatchSettlementEvmScheme, ctx x402.SettleResultContext) error {
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

		hold, holdErr := inspectAdmission(ctx.Ctx, s, normalizedId, pendingId)
		if holdErr != nil {
			return holdErr
		}
		if hold == admissionOther {
			return x402.NewAfterSettleAbort(batchsettlement.ErrChannelBusy, "")
		}
		var recovered *ChannelSession
		if rc != nil {
			recovered = rc.ChannelSnapshot
		}

		missingRow := false
		updateRes, updateErr := s.storage.UpdateChannel(ctx.Ctx, normalizedId, func(current *ChannelSession) *ChannelSession {
			existing := current
			if existing == nil && hold == admissionSelf {
				existing = recovered
			}
			if existing == nil {
				if current == nil {
					missingRow = true
				}
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
			if impl := RethrowLockImplementationError(updateErr); impl != nil {
				return impl
			}
			return x402.NewAfterSettleAbort(batchsettlement.ErrVoucherStoreUnavailable, updateErr.Error())
		}
		if updateRes.Status == ChannelUpdated && updateRes.Channel != nil {
			s.RememberChannelSnapshot(ctx.Payload, updateRes.Channel)
			_ = s.ReleasePendingRequest(ctx.Payload)
			return nil
		}
		if missingRow {
			return x402.NewAfterSettleAbort(batchsettlement.ErrMissingChannel, "")
		}
		return x402.NewAfterSettleAbort(batchsettlement.ErrChannelBusy, "")
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
		hold, holdErr := inspectAdmission(ctx.Ctx, s, normalizedId, pendingId)
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

		updateRes, updateErr := s.storage.UpdateChannel(ctx.Ctx, normalizedId, func(current *ChannelSession) *ChannelSession {
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
	if !s.handlersMatch(ctx.Requirements) {
		return nil, nil
	}
	if s.configuredMode == VoucherStoreModeFacilitator {
		return handleManagedEnrichSettlementResponse(s, ctx)
	}
	return handleEnrichSettlementResponse(s, ctx)
}

func handleEnrichSettlementResponse(s *BatchSettlementEvmScheme, ctx x402.SettleResultContext) (map[string]interface{}, error) {
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
	if v, ok := raw["chargedCumulativeAmount"].(string); ok {
		out.ChargedCumulativeAmount = v
	} else if v, ok := raw["chargedCumulativeAmount"].(float64); ok {
		out.ChargedCumulativeAmount = fmt.Sprintf("%.0f", v)
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

// maxSafeJSONInteger is the largest integer a JSON number carries losslessly (2^53 - 1). It bounds
// the numeric fallback in mapUintStringField so every SDK applies the same rule.
const maxSafeJSONInteger = float64(1<<53 - 1)

// mapUintStringField extracts a non-negative integer field as a decimal string.
// Canonical rule shared across SDKs: a plain decimal string with no leading zeros ("0" is the only
// string starting with 0), or a JSON number that is a non-negative safe integer.
// Unlike mapStringField it has no default: absent or malformed values report ok=false.
func mapUintStringField(m map[string]interface{}, key string) (string, bool) {
	if m == nil {
		return "", false
	}
	switch v := m[key].(type) {
	case string:
		n, ok := new(big.Int).SetString(v, 10)
		if !ok || n.Sign() < 0 || n.String() != v {
			return "", false
		}
		return v, true
	case float64:
		// JSON numbers are bounded to the safe-integer range (2^53 - 1) so the uint64
		// conversion below can neither overflow nor lose precision; NaN fails the Trunc check.
		if v < 0 || v > maxSafeJSONInteger || v != math.Trunc(v) {
			return "", false
		}
		return new(big.Int).SetUint64(uint64(v)).String(), true
	}
	return "", false
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
