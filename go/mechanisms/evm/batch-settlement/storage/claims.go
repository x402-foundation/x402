package storage

import (
	"context"
	"math/big"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// SelectClaimableOptions is the optional wall-clock and idle filter for
// SelectClaimableVouchers.
type SelectClaimableOptions struct {
	Now      int64
	IdleSecs *int
}

// SelectClaimableVouchers collects vouchers that are eligible for onchain claiming.
//
// A voucher is claimable when its chargedCumulativeAmount exceeds what has
// already been claimed onchain. An optional idle filter skips sessions that
// received a request within the last IdleSecs seconds. Input order is preserved.
func SelectClaimableVouchers(channels []*Channel, opts *SelectClaimableOptions) []batchsettlement.BatchSettlementVoucherClaim {
	now := time.Now().UnixMilli()
	if opts != nil && opts.Now != 0 {
		now = opts.Now
	}
	claims := make([]batchsettlement.BatchSettlementVoucherClaim, 0)
	for _, c := range channels {
		if c == nil {
			continue
		}
		if cmp, ok := Uint256Cmp(c.ChargedCumulativeAmount, c.TotalClaimed); !ok || cmp <= 0 {
			continue
		}
		if opts != nil && opts.IdleSecs != nil {
			idleMs := now - c.LastRequestTimestamp
			if idleMs < int64(*opts.IdleSecs)*1000 {
				continue
			}
		}
		claim := batchsettlement.BatchSettlementVoucherClaim{
			Signature:    c.Signature,
			TotalClaimed: c.ChargedCumulativeAmount,
		}
		claim.Voucher.Channel = c.ChannelConfig
		claim.Voucher.MaxClaimableAmount = c.SignedMaxClaimable
		claims = append(claims, claim)
	}
	return claims
}

// ApplyClaimedTotals updates session records after a successful claim so claim
// selection no longer returns already-claimed vouchers.
//
// The callback is authoritative: it re-checks row presence and the claimed
// watermark, so a claim that did not advance totalClaimed costs one no-op
// update rather than a pre-read on every claim.
func ApplyClaimedTotals[T ChannelRecord[T]](ctx context.Context, store ChannelStorage[T], claims []batchsettlement.BatchSettlementVoucherClaim, network string) error {
	for _, claim := range claims {
		channelId, err := batchsettlement.ComputeChannelId(claim.Voucher.Channel, network)
		if err != nil {
			return err
		}
		claimedAmount, ok := new(big.Int).SetString(claim.TotalClaimed, 10)
		if !ok || claimedAmount.Sign() < 0 {
			continue
		}
		if _, err := store.UpdateChannel(ctx, channelId, func(current T) T {
			if isZeroRecord(current) {
				return current
			}
			currentClaimed, ok := new(big.Int).SetString(current.Base().TotalClaimed, 10)
			if !ok || currentClaimed.Sign() < 0 {
				return current
			}
			if claimedAmount.Cmp(currentClaimed) <= 0 {
				return current
			}
			next := current.Clone()
			next.Base().TotalClaimed = claimedAmount.String()
			return next
		}); err != nil {
			return err
		}
	}
	return nil
}
