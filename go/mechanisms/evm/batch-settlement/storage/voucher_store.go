package storage

import (
	"context"
	"encoding/hex"
	"math/big"
	"strconv"
	"strings"
	"time"

	"github.com/ethereum/go-ethereum/crypto"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
	"github.com/x402-foundation/x402/go/v2/types"
)

const (
	minPendingTtlMs = 5_000
	// MaxPendingTtlMs is the admission-lock ceiling: 10 minutes (600s).
	// PendingTtlMs clamps a verify lock to this. Idle refund uses the same
	// ceiling so a crashed refund does not hold the channel any longer.
	MaxPendingTtlMs int64 = 10 * 60 * 1000
)

// VoucherStoreMode says who owns the authoritative offchain voucher store.
type VoucherStoreMode string

const (
	VoucherStoreModeSelf        VoucherStoreMode = "self"
	VoucherStoreModeFacilitator VoucherStoreMode = "facilitator"
)

// CommitVoucherChargeInput is the charge increment, signed cap, voucher, and
// optional snapshot/map applied by CommitVoucherCharge.
type CommitVoucherChargeInput[T ChannelRecord[T]] struct {
	Increment           *big.Int
	SignedCap           *big.Int
	ExpectedCharged     *big.Int
	Voucher             batchsettlement.BatchSettlementVoucherFields
	Snapshot            T
	ResolveSnapshot     func(current T) T
	RecoverFromSnapshot *bool
	Now                 int64
	LocalVerify         bool
	Map                 func(T) T
}

// CommitVoucherChargeStatus is the CAS outcome of CommitVoucherCharge.
type CommitVoucherChargeStatus string

const (
	CommitMissing           CommitVoucherChargeStatus = "missing"
	CommitCapExceeded       CommitVoucherChargeStatus = "cap_exceeded"
	CommitWatermarkMismatch CommitVoucherChargeStatus = "watermark_mismatch"
	CommitCommitted         CommitVoucherChargeStatus = "committed"
	CommitConflict          CommitVoucherChargeStatus = "conflict"
)

// CommitVoucherChargeResult is the CAS outcome of CommitVoucherCharge.
type CommitVoucherChargeResult[T ChannelRecord[T]] struct {
	Status   CommitVoucherChargeStatus
	Charged  string
	Previous *Channel
	Current  T
}

// IsFacilitatorManaged reports whether extra.voucherManager is "facilitator".
// An omitted voucherManager means "server".
func IsFacilitatorManaged(extra map[string]interface{}) bool {
	if extra == nil {
		return false
	}
	v, ok := extra["voucherManager"].(string)
	return ok && v == batchsettlement.VoucherManagerFacilitator
}

// AdvertisedVoucherManagers reads the voucher-management modes a facilitator advertises
// in its /supported kind extra. extra.voucherManager is an array there; omitting it means
// ["server"]. A malformed (non-array) value advertises nothing. Unknown values are dropped.
func AdvertisedVoucherManagers(extra map[string]interface{}) []string {
	advertised, present := extra["voucherManager"]
	if !present {
		return []string{batchsettlement.VoucherManagerServer}
	}
	var items []interface{}
	switch v := advertised.(type) {
	case []string:
		for _, s := range v {
			items = append(items, s)
		}
	case []interface{}:
		items = v
	default:
		return []string{}
	}
	managers := make([]string, 0, len(items))
	for _, item := range items {
		s, ok := item.(string)
		if ok && (s == batchsettlement.VoucherManagerServer || s == batchsettlement.VoucherManagerFacilitator) {
			managers = append(managers, s)
		}
	}
	return managers
}

// AdvertisesVoucherManager reports whether the facilitator's /supported kind extra
// advertises the given voucher-management mode.
func AdvertisesVoucherManager(extra map[string]interface{}, manager string) bool {
	for _, m := range AdvertisedVoucherManagers(extra) {
		if m == manager {
			return true
		}
	}
	return false
}

// VoucherStoreModeOf resolves VoucherStoreMode from payment requirements.
func VoucherStoreModeOf(requirements types.PaymentRequirements) VoucherStoreMode {
	if IsFacilitatorManaged(requirements.Extra) {
		return VoucherStoreModeFacilitator
	}
	return VoucherStoreModeSelf
}

// PendingTtlMs computes the bounded admission-lock TTL from the resource
// timeout. The result is clamped to 5s–600s. A zero or negative timeout
// is treated as zero before clamping.
func PendingTtlMs(maxTimeoutSeconds int) int64 {
	requestedMs := int64(maxTimeoutSeconds) * 1000
	if requestedMs < 0 {
		requestedMs = 0
	}
	if requestedMs < minPendingTtlMs {
		return minPendingTtlMs
	}
	if requestedMs > MaxPendingTtlMs {
		return MaxPendingTtlMs
	}
	return requestedMs
}

// DefaultOnchainStateTtlMs derives a freshness window from the channel
// withdraw delay: withdrawDelay/3, clamped between 30 seconds and 5 minutes.
func DefaultOnchainStateTtlMs(withdrawDelaySeconds int) int64 {
	if withdrawDelaySeconds < 0 {
		withdrawDelaySeconds = 0
	}
	ttl := int64(withdrawDelaySeconds) * 1000 / 3
	const minTtl = int64(30 * 1000)
	const maxTtl = int64(5 * 60 * 1000)
	if ttl < minTtl {
		return minTtl
	}
	if ttl > maxTtl {
		return maxTtl
	}
	return ttl
}

// AdmissionOwner binds a server-authored pendingId to the voucher it reserved.
//
// The lock store only holds one owner string, so the reservation key is this
// hash rather than the wire pendingId. A settle that echoes pendingId with a
// different voucher cannot present as the holder.
func AdmissionOwner(pendingId string, voucher batchsettlement.BatchSettlementVoucherFields) string {
	material := strings.ToLower(pendingId + "|" + voucher.ChannelId + "|" + voucher.MaxClaimableAmount + "|" + voucher.Signature)
	return "0x" + hex.EncodeToString(crypto.Keccak256([]byte(material)))
}

// ChannelStateExtra converts stored channel state into the public response snapshot.
func ChannelStateExtra(channel *Channel, chargedCumulativeAmount *string) batchsettlement.BatchSettlementChannelStateExtra {
	extra := batchsettlement.BatchSettlementChannelStateExtra{
		ChannelId:           channel.ChannelId,
		Balance:             channel.Balance,
		TotalClaimed:        channel.TotalClaimed,
		WithdrawRequestedAt: channel.WithdrawRequestedAt,
		RefundNonce:         strconv.Itoa(channel.RefundNonce),
	}
	if chargedCumulativeAmount != nil {
		extra.ChargedCumulativeAmount = *chargedCumulativeAmount
	}
	return extra
}

// PaymentResponseExtra builds payment-response extra. Self-managed paid
// responses are channelState, then chargedAmount. Facilitator-managed adds
// chargeCount after that. Refunds omit chargedAmount.
func PaymentResponseExtra(
	channelState batchsettlement.BatchSettlementChannelStateExtra,
	chargedAmount *string,
	chargeCount *int,
) batchsettlement.BatchSettlementPaymentResponseExtra {
	out := batchsettlement.BatchSettlementPaymentResponseExtra{
		ChannelState: &channelState,
		ChargeCount:  chargeCount,
	}
	if chargedAmount != nil {
		out.ChargedAmount = *chargedAmount
	}
	return out
}

// CommitVoucherCharge atomically increments chargedCumulativeAmount under the
// storage CAS.
//
// Any storage outcome other than status "updated" with a committed callback
// result (including status "conflict" from a contended compare-and-write)
// maps to status "conflict". Unchanged-row outcomes are returned as-is.
func CommitVoucherCharge[T ChannelRecord[T]](ctx context.Context, store ChannelStorage[T], channelId string, input CommitVoucherChargeInput[T]) (*CommitVoucherChargeResult[T], error) {
	now := input.Now
	if now == 0 {
		now = time.Now().UnixMilli()
	}
	var outcome *CommitVoucherChargeResult[T]

	updateResult, err := store.UpdateChannel(ctx, channelId, func(current T) T {
		recoverFromSnapshot := true
		if input.RecoverFromSnapshot != nil {
			recoverFromSnapshot = *input.RecoverFromSnapshot
		}
		resolved := input.Snapshot
		if input.ResolveSnapshot != nil {
			resolved = input.ResolveSnapshot(current)
		}
		base := current
		if isZeroRecord(base) && recoverFromSnapshot {
			base = resolved
		}
		if isZeroRecord(base) {
			outcome = &CommitVoucherChargeResult[T]{Status: CommitMissing}
			return current
		}

		charged, ok := new(big.Int).SetString(base.Base().ChargedCumulativeAmount, 10)
		if !ok || charged.Sign() < 0 {
			// Fail closed on a corrupt watermark: leave the row unchanged.
			// The CAS no-op maps to CommitConflict below.
			outcome = &CommitVoucherChargeResult[T]{Status: CommitConflict}
			return current
		}
		if input.ExpectedCharged != nil && charged.Cmp(input.ExpectedCharged) != 0 {
			outcome = &CommitVoucherChargeResult[T]{Status: CommitWatermarkMismatch, Charged: charged.String()}
			return current
		}
		increment := input.Increment
		if increment == nil {
			increment = new(big.Int)
		}
		signedCap := input.SignedCap
		if signedCap == nil {
			signedCap = new(big.Int)
		}
		newCharged := new(big.Int).Add(charged, increment)
		if newCharged.Cmp(signedCap) > 0 {
			outcome = &CommitVoucherChargeResult[T]{Status: CommitCapExceeded, Charged: newCharged.String()}
			return current
		}

		updated := base.Clone()
		ub := updated.Base()
		if !input.LocalVerify && !isZeroRecord(resolved) {
			snap := resolved.Base()
			ub.Balance = snap.Balance
			// Deposit snapshots mirror escrow; the claimed watermark only moves forward.
			ub.TotalClaimed = MaxUint256String(ub.TotalClaimed, snap.TotalClaimed)
			ub.WithdrawRequestedAt = snap.WithdrawRequestedAt
			ub.RefundNonce = snap.RefundNonce
			// The stamp is the read time of the escrow fields; zero is no observation.
			if snap.OnchainSyncedAt > ub.OnchainSyncedAt {
				ub.OnchainSyncedAt = snap.OnchainSyncedAt
			}
		}
		ub.ChargedCumulativeAmount = newCharged.String()
		ub.SignedMaxClaimable = input.Voucher.MaxClaimableAmount
		ub.Signature = input.Voucher.Signature
		ub.LastRequestTimestamp = now
		if input.Map != nil {
			updated = input.Map(updated)
		}
		outcome = &CommitVoucherChargeResult[T]{Status: CommitCommitted, Previous: base.Base().Clone(), Current: updated}
		return updated
	})
	if err != nil {
		return nil, err
	}
	if outcome != nil && (outcome.Status == CommitMissing || outcome.Status == CommitCapExceeded || outcome.Status == CommitWatermarkMismatch) {
		return outcome, nil
	}
	if updateResult.Status != ChannelUpdated || outcome == nil || outcome.Status != CommitCommitted {
		return &CommitVoucherChargeResult[T]{Status: CommitConflict}, nil
	}
	return outcome, nil
}

// MaxUint256String returns the greater decimal uint256.
// An unparseable operand leaves current in place.
func MaxUint256String(current, next string) string {
	cmp, ok := Uint256Cmp(current, next)
	if !ok || cmp >= 0 {
		return current
	}
	return next
}
