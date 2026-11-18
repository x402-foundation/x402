package facilitator

import (
	"context"
	"errors"
	"log/slog"
	"math/big"
	"sort"
	"strings"
	"time"

	"github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement/storage"
)

type claimSortClass int

const (
	claimSortWithdraw claimSortClass = iota
	claimSortReserved
	claimSortUnclaimed
)

type claimSortKey struct {
	class      claimSortClass
	withdrawAt int
	unclaimed  *big.Int
}

func reportClaimError(logger *slog.Logger, opts *FacilitatorClaimOptions, err error, channelID string) {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	if opts != nil && opts.OnError != nil {
		opts.OnError(err, channelID)
		return
	}
	if channelID != "" {
		logger.Error("batch-settlement: claim channel", "channel_id", channelID, "error", err)
		return
	}
	logger.Error("batch-settlement: claim", "error", err)
}

func reportSettleError(logger *slog.Logger, opts *FacilitatorSettleOptions, err error, target *storage.SettleTarget) {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	if opts != nil && opts.OnError != nil {
		opts.OnError(err, target)
		return
	}
	if target != nil {
		logger.Error("batch-settlement: settle", "receiver", target.Receiver, "token", target.Token, "network", target.Network, "error", err)
		return
	}
	logger.Error("batch-settlement: settle", "error", err)
}

func reportRefundError(logger *slog.Logger, onError func(error, string), err error, channelID string) {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return
	}
	if onError != nil {
		onError(err, channelID)
		return
	}
	logger.Error("batch-settlement: refund channel", "channel_id", channelID, "error", err)
}

// sortClaimRows orders withdraw-pending rows first (earliest request), then
// reserved idle rows, then highest unclaimed. Keys are computed before the sort.
func sortClaimRows(rows []*FacilitatorChannel, reserved map[string]struct{}) {
	type keyed struct {
		row *FacilitatorChannel
		key claimSortKey
	}
	keyedRows := make([]keyed, len(rows))
	for i, row := range rows {
		keyedRows[i] = keyed{row: row, key: claimSortKeyFor(row, reserved)}
	}
	sort.SliceStable(keyedRows, func(i, j int) bool {
		return claimSortLess(keyedRows[i].key, keyedRows[j].key)
	})
	for i := range keyedRows {
		rows[i] = keyedRows[i].row
	}
}

func claimSortKeyFor(row *FacilitatorChannel, reserved map[string]struct{}) claimSortKey {
	if row != nil && row.WithdrawRequestedAt > 0 {
		return claimSortKey{class: claimSortWithdraw, withdrawAt: row.WithdrawRequestedAt}
	}
	if row != nil && reserved != nil {
		if _, ok := reserved[strings.ToLower(row.ChannelId)]; ok {
			return claimSortKey{class: claimSortReserved}
		}
	}
	unclaimed := new(big.Int)
	if row != nil {
		unclaimed = storage.UnclaimedAmount(row.Base())
	}
	return claimSortKey{class: claimSortUnclaimed, unclaimed: unclaimed}
}

func claimSortLess(a, b claimSortKey) bool {
	if a.class != b.class {
		return a.class < b.class
	}
	if a.class == claimSortWithdraw && a.withdrawAt != b.withdrawAt {
		return a.withdrawAt < b.withdrawAt
	}
	if a.class == claimSortUnclaimed {
		if a.unclaimed == nil || b.unclaimed == nil {
			return false
		}
		return a.unclaimed.Cmp(b.unclaimed) > 0
	}
	return false
}

func (m *FacilitatorChannelManager) loadClaimRows(
	ctx context.Context,
	opts *FacilitatorClaimOptions,
	maxClaimsPerBatch int,
) ([]*FacilitatorChannel, error) {
	capacity := claimCapacity(opts, maxClaimsPerBatch)
	query := m.claimRowQuery(ctx, opts)
	if opts != nil && opts.SelectClaimRows != nil {
		return opts.SelectClaimRows(ctx, query, capacity)
	}
	limit := maxClaimsPerBatch
	if capacity > 0 {
		limit = capacity
	}
	if opts == nil || !opts.MinUnclaimed.active() {
		filter := storage.ChannelQuery{Limit: &limit}
		if opts != nil {
			filter.UnclaimedDesc = opts.UnclaimedDesc
		}
		items, err := query(filter)
		if err != nil {
			return nil, err
		}
		if capacity > 0 && len(items) > capacity {
			items = items[:capacity]
		}
		sortClaimRows(items, nil)
		return items, nil
	}
	return m.selectGatedClaimRows(ctx, opts, limit)
}

func claimCapacity(opts *FacilitatorClaimOptions, maxClaimsPerBatch int) int {
	if opts != nil && opts.MaxTxsPerRun > 0 {
		return opts.MaxTxsPerRun * maxClaimsPerBatch
	}
	return 0
}

func (m *FacilitatorChannelManager) claimRowQuery(
	ctx context.Context,
	opts *FacilitatorClaimOptions,
) func(storage.ChannelQuery) ([]*FacilitatorChannel, error) {
	return func(q storage.ChannelQuery) ([]*FacilitatorChannel, error) {
		filter := storage.ChannelQuery{
			Kind:          storage.QueryKindClaimable,
			Limit:         q.Limit,
			Cursor:        q.Cursor,
			Network:       q.Network,
			UnclaimedDesc: q.UnclaimedDesc,
			OldestFirst:   q.OldestFirst,
			MinUnclaimed:  q.MinUnclaimed,
		}
		if opts != nil && opts.IdleSecs != nil {
			idleAt := time.Now().UnixMilli() - int64(*opts.IdleSecs)*1000
			filter.IdleAtOrBefore = &idleAt
		}
		page, err := storage.QueryChannels(ctx, m.storage, filter, nil)
		if err != nil {
			return nil, err
		}
		if page == nil {
			return nil, nil
		}
		return page.Items, nil
	}
}

// selectGatedClaimRows applies MinUnclaimed per token.
func (m *FacilitatorChannelManager) selectGatedClaimRows(
	ctx context.Context,
	opts *FacilitatorClaimOptions,
	limit int,
) ([]*FacilitatorChannel, error) {
	if limit <= 0 {
		limit = defaultSettleQueryPageSize
	}
	var idleAt *int64
	if opts.IdleSecs != nil {
		at := time.Now().UnixMilli() - int64(*opts.IdleSecs)*1000
		idleAt = &at
	}
	pageSize := limit
	if pageSize > defaultSettleQueryPageSize {
		pageSize = defaultSettleQueryPageSize
	}
	kept := make([]*FacilitatorChannel, 0, pageSize)
	cursor := ""
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		size := pageSize
		page, err := storage.QueryChannels(ctx, m.storage, storage.ChannelQuery{
			Kind:          storage.QueryKindClaimable,
			Limit:         &size,
			Cursor:        cursor,
			UnclaimedDesc: opts.UnclaimedDesc,
		}, nil)
		if err != nil {
			return nil, err
		}
		if page == nil || len(page.Items) == 0 {
			break
		}
		for _, row := range page.Items {
			meets, err := claimRowMeetsAmountGate(row, opts.MinUnclaimed, idleAt)
			if err != nil {
				return nil, err
			}
			if meets {
				kept = append(kept, row)
			}
		}
		if len(kept) >= limit || page.Cursor == "" || page.Cursor == cursor {
			break
		}
		cursor = page.Cursor
	}
	if len(kept) > limit {
		kept = kept[:limit]
	}
	sortClaimRows(kept, nil)
	return kept, nil
}

// claimRowMeetsAmountGate reports whether row meets the token threshold.
func claimRowMeetsAmountGate(row *FacilitatorChannel, gate TokenAmountGate, idleAt *int64) (bool, error) {
	if row == nil {
		return false, nil
	}
	base := row.Base()
	if base == nil {
		return false, nil
	}
	if base.WithdrawRequestedAt > 0 {
		return true, nil
	}
	if idleAt != nil && base.LastRequestTimestamp <= *idleAt {
		return true, nil
	}
	atomic, gated, err := gate.Resolve(base.Network, base.ChannelConfig.Token)
	if err != nil {
		return false, err
	}
	if !gated {
		return true, nil
	}
	return storage.UnclaimedAmount(base).Cmp(atomic) >= 0, nil
}
