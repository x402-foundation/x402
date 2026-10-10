package storage

import (
	"context"
	"math/big"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const defaultSettleTargetPageSize = 100

// SettleTargetClaimDelta is the claim amount added to a receiver pair.
type SettleTargetClaimDelta struct {
	Network  string
	Receiver string
	Token    string
	Amount   *big.Int
}

// SettleTargetObservation is one onchain pending read for a claimed pair.
type SettleTargetObservation struct {
	Target   SettleTarget
	Pending  *big.Int
	AtMillis int64
	// UpdatedBefore limits both the zero-pending delete and the positive overwrite to rows
	// whose updatedAt is strictly older, or missing. Zero applies by key. A claim that
	// upserts the row after the receivers() read keeps its delta.
	UpdatedBefore int64
}

// SettleTargetStorage tracks claimed (network, receiver, token) pairs.
// ListSettleTargets may treat SettleQuery.MinPending as a filter hint.
type SettleTargetStorage interface {
	RecordClaimed(ctx context.Context, delta SettleTargetClaimDelta) error
	ListSettleTargets(ctx context.Context, q SettleQuery) (*QueryPage[SettleTarget], error)
	// RemoveSettleTarget deletes one pair.
	// updatedBeforeMillis > 0 deletes only when updatedAt is strictly older than that
	// unix-milli instant, or the row has no updatedAt. Zero deletes by key.
	RemoveSettleTarget(ctx context.Context, target SettleTarget, updatedBeforeMillis int64) error
}

// SettleTargetObserver applies onchain pending after a settle read.
// Stores that do not implement it are left unchanged.
type SettleTargetObserver interface {
	ObserveSettlePending(ctx context.Context, obs []SettleTargetObservation) error
}

// InMemorySettleTargetStorage is a process-local cache keyed by network, receiver, and token.
// Pending amounts keep full uint256 precision. Pass it explicitly; nil manager config derives targets from channels.
type InMemorySettleTargetStorage struct {
	mu      sync.Mutex
	entries map[string]*inMemorySettleTargetEntry
}

type inMemorySettleTargetEntry struct {
	network       string
	receiver      string
	token         string
	pendingAmount *big.Int
	lastAttemptAt int64
	updatedAt     int64
}

var _ SettleTargetStorage = (*InMemorySettleTargetStorage)(nil)
var _ SettleTargetObserver = (*InMemorySettleTargetStorage)(nil)

func NewInMemorySettleTargetStorage() *InMemorySettleTargetStorage {
	return &InMemorySettleTargetStorage{
		entries: make(map[string]*inMemorySettleTargetEntry),
	}
}

func settleTargetKey(network, receiver, token string) string {
	return strings.ToLower(network) + ":" + strings.ToLower(receiver) + ":" + strings.ToLower(token)
}

func (s *InMemorySettleTargetStorage) ListSettleTargets(
	_ context.Context,
	filter SettleQuery,
) (*QueryPage[SettleTarget], error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	rows := make([]settleCursorRow, 0, len(s.entries))
	for _, entry := range s.entries {
		if !pendingAboveMin(entry.pendingAmount, filter.MinPending) {
			continue
		}
		if filter.Network != "" && !strings.EqualFold(entry.network, filter.Network) {
			continue
		}
		rows = append(rows, settleCursorRow{
			target: SettleTarget{
				Network:  entry.network,
				Receiver: entry.receiver,
				Token:    entry.token,
			},
			at: entry.lastAttemptAt,
		})
	}
	sort.Slice(rows, func(i, j int) bool {
		if rows[i].at != rows[j].at {
			return rows[i].at < rows[j].at
		}
		if rows[i].target.Receiver != rows[j].target.Receiver {
			return rows[i].target.Receiver < rows[j].target.Receiver
		}
		return rows[i].target.Token < rows[j].target.Token
	})
	if _, _, _, ok := decodeSettleTargetCursor(filter.Cursor); !ok {
		return &QueryPage[SettleTarget]{Items: []SettleTarget{}}, nil
	}
	start := settleTargetCursorIndex(rows, filter.Cursor)
	limit := settleQueryLimit(filter.Limit)
	end := start + limit
	if end > len(rows) {
		end = len(rows)
	}
	items := make([]SettleTarget, 0, end-start)
	for _, row := range rows[start:end] {
		items = append(items, row.target)
	}
	out := &QueryPage[SettleTarget]{Items: items}
	if end < len(rows) && len(items) > 0 {
		last := rows[end-1]
		out.Cursor = encodeSettleTargetCursor(last.at, last.target.Receiver, last.target.Token)
	}
	return out, nil
}

func settleQueryLimit(limit *int) int {
	if limit == nil || *limit <= 0 {
		return defaultSettleTargetPageSize
	}
	return *limit
}

func (s *InMemorySettleTargetStorage) RecordClaimed(
	_ context.Context,
	delta SettleTargetClaimDelta,
) error {
	if delta.Amount == nil || delta.Amount.Sign() <= 0 {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := settleTargetKey(delta.Network, delta.Receiver, delta.Token)
	entry := s.entries[key]
	now := time.Now().UnixMilli()
	if entry == nil {
		entry = &inMemorySettleTargetEntry{
			network:       delta.Network,
			receiver:      strings.ToLower(delta.Receiver),
			token:         strings.ToLower(delta.Token),
			pendingAmount: new(big.Int),
			lastAttemptAt: now,
		}
		s.entries[key] = entry
	}
	if entry.pendingAmount == nil {
		entry.pendingAmount = new(big.Int)
	}
	entry.pendingAmount = new(big.Int).Add(entry.pendingAmount, delta.Amount)
	entry.updatedAt = now
	return nil
}

func (s *InMemorySettleTargetStorage) RemoveSettleTarget(_ context.Context, target SettleTarget, updatedBeforeMillis int64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deleteIfStale(settleTargetKey(target.Network, target.Receiver, target.Token), updatedBeforeMillis)
	return nil
}

func (s *InMemorySettleTargetStorage) ObserveSettlePending(_ context.Context, obs []SettleTargetObservation) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	observedAt := time.Now().UnixMilli()
	for _, item := range obs {
		key := settleTargetKey(item.Target.Network, item.Target.Receiver, item.Target.Token)
		if item.Pending == nil || item.Pending.Sign() <= 0 {
			s.deleteIfStale(key, item.UpdatedBefore)
			continue
		}
		entry := s.entries[key]
		if entry != nil && item.UpdatedBefore > 0 && entry.updatedAt >= item.UpdatedBefore {
			continue
		}
		if entry == nil {
			entry = &inMemorySettleTargetEntry{
				network:  item.Target.Network,
				receiver: strings.ToLower(item.Target.Receiver),
				token:    strings.ToLower(item.Target.Token),
			}
			s.entries[key] = entry
		}
		entry.pendingAmount = new(big.Int).Set(item.Pending)
		entry.lastAttemptAt = item.AtMillis
		entry.updatedAt = observedAt
	}
	return nil
}

// deleteIfStale removes key. updatedBeforeMillis > 0 keeps a row updated at or after that instant.
func (s *InMemorySettleTargetStorage) deleteIfStale(key string, updatedBeforeMillis int64) {
	if updatedBeforeMillis > 0 {
		entry := s.entries[key]
		if entry != nil && entry.updatedAt >= updatedBeforeMillis {
			return
		}
	}
	delete(s.entries, key)
}

func pendingAboveMin(pending, minPending *big.Int) bool {
	if pending == nil || pending.Sign() <= 0 {
		return false
	}
	if minPending == nil {
		return true
	}
	return pending.Cmp(minPending) > 0
}

type settleCursorRow struct {
	target SettleTarget
	at     int64
}

func settleTargetCursorIndex(rows []settleCursorRow, raw string) int {
	at, receiver, token, ok := decodeSettleTargetCursor(raw)
	if !ok || (at == 0 && receiver == "" && token == "") {
		return 0
	}
	for i, row := range rows {
		if row.at > at {
			return i
		}
		if row.at == at {
			ki := row.target.Receiver + ":" + row.target.Token
			ck := receiver + ":" + token
			if ki > ck {
				return i
			}
		}
	}
	return len(rows)
}

func encodeSettleTargetCursor(at int64, receiver, token string) string {
	return strconv.FormatInt(at, 10) + "|" + strings.ToLower(receiver) + "|" + strings.ToLower(token)
}

func decodeSettleTargetCursor(raw string) (int64, string, string, bool) {
	if raw == "" {
		return 0, "", "", true
	}
	parts := strings.SplitN(raw, "|", 3)
	if len(parts) != 3 {
		return 0, "", "", false
	}
	at, err := strconv.ParseInt(parts[0], 10, 64)
	if err != nil {
		return 0, "", "", false
	}
	return at, strings.ToLower(parts[1]), strings.ToLower(parts[2]), true
}
