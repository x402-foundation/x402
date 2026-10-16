package storage

import (
	"context"
	"sort"
	"strconv"
	"strings"
)

// NewChannelSettleTargets lists claimed pairs by scanning channel rows with totalClaimed > 0.
// RecordClaimed and RemoveSettleTarget are no-ops; settle re-reads pending onchain.
func NewChannelSettleTargets[T ChannelRecord[T]](store ChannelStorage[T]) SettleTargetStorage {
	return &channelSettleTargets[T]{store: store}
}

type channelSettleTargets[T ChannelRecord[T]] struct {
	store ChannelStorage[T]
}

func (s *channelSettleTargets[T]) RecordClaimed(context.Context, SettleTargetClaimDelta) error {
	return nil
}

func (s *channelSettleTargets[T]) RemoveSettleTarget(context.Context, SettleTarget, int64) error {
	return nil
}

func (s *channelSettleTargets[T]) ListSettleTargets(ctx context.Context, q SettleQuery) (*QueryPage[SettleTarget], error) {
	if s.store == nil {
		return &QueryPage[SettleTarget]{Items: []SettleTarget{}}, nil
	}
	rows, err := s.store.List(ctx)
	if err != nil {
		return nil, err
	}
	seen := make(map[string]SettleTarget)
	for _, row := range rows {
		base := row.Base()
		if base == nil {
			continue
		}
		if q.Network != "" && !strings.EqualFold(base.Network, q.Network) {
			continue
		}
		claimed, ok := ParseUint256(base.TotalClaimed)
		if !ok || claimed.Sign() <= 0 {
			continue
		}
		receiver := strings.ToLower(base.ChannelConfig.Receiver)
		token := strings.ToLower(base.ChannelConfig.Token)
		if receiver == "" || token == "" {
			continue
		}
		key := strings.ToLower(base.Network) + ":" + receiver + ":" + token
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = SettleTarget{
			Network:  base.Network,
			Receiver: receiver,
			Token:    token,
		}
	}
	items := make([]SettleTarget, 0, len(seen))
	for _, target := range seen {
		items = append(items, target)
	}
	sortSettleTargets(items)
	start := ParseQueryCursor(q.Cursor)
	if start > len(items) {
		start = len(items)
	}
	limit := settleQueryLimit(q.Limit)
	end := start + limit
	if end > len(items) {
		end = len(items)
	}
	out := &QueryPage[SettleTarget]{Items: items[start:end]}
	if end < len(items) {
		out.Cursor = strconv.Itoa(end)
	}
	return out, nil
}

func sortSettleTargets(items []SettleTarget) {
	sort.Slice(items, func(i, j int) bool {
		return settleTargetLess(items[i], items[j])
	})
}

func settleTargetLess(a, b SettleTarget) bool {
	if a.Network != b.Network {
		return a.Network < b.Network
	}
	if a.Receiver != b.Receiver {
		return a.Receiver < b.Receiver
	}
	return a.Token < b.Token
}
