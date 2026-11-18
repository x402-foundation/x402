package storage

import (
	"context"
	"encoding/json"
	"errors"
	"sort"
	"sync"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// Channel is the durable per-channel record shared by server and facilitator stores.
type Channel struct {
	ChannelId               string                        `json:"channelId"`
	ChannelConfig           batchsettlement.ChannelConfig `json:"channelConfig"`
	ChargedCumulativeAmount string                        `json:"chargedCumulativeAmount"`
	SignedMaxClaimable      string                        `json:"signedMaxClaimable"`
	Signature               string                        `json:"signature"`
	Balance                 string                        `json:"balance"`
	TotalClaimed            string                        `json:"totalClaimed"`
	WithdrawRequestedAt     int                           `json:"withdrawRequestedAt"`
	RefundNonce             int                           `json:"refundNonce"`
	LastRequestTimestamp    int64                         `json:"lastRequestTimestamp"`
	OnchainSyncedAt         int64                         `json:"onchainSyncedAt,omitempty"`
	Network                 string                        `json:"network,omitempty"`
}

// Base returns the channel itself so generic stores can read shared fields.
func (c *Channel) Base() *Channel { return c }

// Clone returns a shallow copy. A nil receiver yields nil so missing rows stay missing.
func (c *Channel) Clone() *Channel {
	if c == nil {
		return nil
	}
	cp := *c
	return &cp
}

// ChannelRecord is the constraint used by ChannelStorage: a record that exposes
// the shared Channel fields and can clone itself as T.
type ChannelRecord[T any] interface {
	Base() *Channel
	Clone() T
}

// ChannelUpdateStatus describes the outcome of an UpdateChannel call.
type ChannelUpdateStatus string

const (
	ChannelUpdated   ChannelUpdateStatus = "updated"
	ChannelUnchanged ChannelUpdateStatus = "unchanged"
	ChannelDeleted   ChannelUpdateStatus = "deleted"
	ChannelConflict  ChannelUpdateStatus = "conflict"
)

// ChannelUpdateResult is the result of an UpdateChannel call.
type ChannelUpdateResult[T ChannelRecord[T]] struct {
	Channel T
	Status  ChannelUpdateStatus
}

// ChannelStorage persists channel records of type T. Get returns the zero T
// (nil for pointer records) when the row is missing.
type ChannelStorage[T ChannelRecord[T]] interface {
	Get(ctx context.Context, channelId string) (T, error)
	List(ctx context.Context) ([]T, error)
	UpdateChannel(ctx context.Context, channelId string, update func(current T) T) (*ChannelUpdateResult[T], error)
}

// ChannelLockStorage is a per-channel admission lock. Acquire errors fail closed at verify
// and at unheld voucher settle; the durable charge CAS still serializes commits.
type ChannelLockStorage interface {
	// Acquire is SET NX + TTL. Value is pendingId. Expired keys are free.
	Acquire(ctx context.Context, channelId string, pendingId string, ttlMs int64) (bool, error)
	// Release is compare-and-delete: releases only when pendingId still holds.
	Release(ctx context.Context, channelId string, pendingId string) error
	// IsHeld reports any live lock, or this pendingId when provided (empty
	// pendingId means any live lock).
	IsHeld(ctx context.Context, channelId string, pendingId string) (bool, error)
}

// RethrowLockImplementationError returns err when it is a lock-store
// implementation/parse failure so callers fail closed.
//
// json.SyntaxError and json.UnmarshalTypeError indicate a broken backend or
// unreadable File .hold JSON. Redis lock I/O (network, timeout) is not in this
// set and stays optimistic: callers treat the lock as absent and the charge
// CAS still serializes commits.
func RethrowLockImplementationError(err error) error {
	if err == nil {
		return nil
	}
	var syntax *json.SyntaxError
	var unmarshalType *json.UnmarshalTypeError
	if errors.As(err, &syntax) || errors.As(err, &unmarshalType) {
		return err
	}
	return nil
}

// IsChannelLockStorage reports whether value implements ChannelLockStorage.
func IsChannelLockStorage(value any) bool {
	_, ok := value.(ChannelLockStorage)
	return ok
}

type admissionLock struct {
	PendingId string `json:"pendingId"`
	ExpiresAt int64  `json:"expiresAt"`
}

// InMemoryChannelStorage is a volatile ChannelStorage backed by a map.
//
// The per-channel lock map is allocated lazily and retained for the lifetime
// of the store so a caller holding the old *sync.Mutex cannot race a fresh
// lockFor allocation for the same id. The admission-lock map is dropped when
// UpdateChannel deletes the row. Long-lived servers that see an unbounded set
// of distinct channelIds will grow the lock map; production deployments
// should prefer Delete-on-drain via UpdateChannel returning the zero T.
type InMemoryChannelStorage[T ChannelRecord[T]] struct {
	mu             sync.Mutex
	sessions       map[string]T
	locks          map[string]*sync.Mutex
	admissionLocks map[string]admissionLock
}

var (
	_ ChannelStorage[*Channel] = (*InMemoryChannelStorage[*Channel])(nil)
	_ ChannelLockStorage       = (*InMemoryChannelStorage[*Channel])(nil)
)

// NewInMemoryChannelStorage creates a new in-memory channel store.
func NewInMemoryChannelStorage[T ChannelRecord[T]]() *InMemoryChannelStorage[T] {
	return &InMemoryChannelStorage[T]{
		sessions:       make(map[string]T),
		locks:          make(map[string]*sync.Mutex),
		admissionLocks: make(map[string]admissionLock),
	}
}

func (s *InMemoryChannelStorage[T]) lockFor(channelId string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock, ok := s.locks[channelId]
	if !ok {
		lock = &sync.Mutex{}
		s.locks[channelId] = lock
	}
	return lock
}

// Get returns a clone of the stored record, or the zero T when missing.
func (s *InMemoryChannelStorage[T]) Get(_ context.Context, channelId string) (T, error) {
	var zero T
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return zero, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[key]
	if !ok {
		return zero, nil
	}
	return session.Clone(), nil
}

// List returns clones of every stored record, sorted by channelId so scan-backed
// queries see a stable order.
func (s *InMemoryChannelStorage[T]) List(_ context.Context) ([]T, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]T, 0, len(s.sessions))
	for _, session := range s.sessions {
		result = append(result, session.Clone())
	}
	sort.Slice(result, func(i, j int) bool { return result[i].Base().ChannelId < result[j].Base().ChannelId })
	return result, nil
}

// UpdateChannel applies update under a per-channel mutex. Returning the same
// pointer is a no-op; returning the zero T deletes the row.
func (s *InMemoryChannelStorage[T]) UpdateChannel(_ context.Context, channelId string, update func(current T) T) (*ChannelUpdateResult[T], error) {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return nil, err
	}
	lock := s.lockFor(key)
	lock.Lock()
	defer lock.Unlock()

	s.mu.Lock()
	current, exists := s.sessions[key]
	var currentCopy T
	if exists {
		currentCopy = current.Clone()
	}
	s.mu.Unlock()

	next := update(currentCopy)
	if sameRecord(next, currentCopy) {
		return &ChannelUpdateResult[T]{Channel: currentCopy, Status: ChannelUnchanged}, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if isZeroRecord(next) {
		if exists {
			delete(s.sessions, key)
			delete(s.admissionLocks, key)
			return &ChannelUpdateResult[T]{Status: ChannelDeleted}, nil
		}
		return &ChannelUpdateResult[T]{Status: ChannelUnchanged}, nil
	}
	stored := next.Clone()
	s.sessions[key] = stored
	return &ChannelUpdateResult[T]{Channel: stored.Clone(), Status: ChannelUpdated}, nil
}

// Acquire takes a per-channel admission lock. It is not re-entrant: a live
// hold, including one owned by the same pendingId, is a miss. Refreshing TTL
// for a matching pendingId races and can extend another holder's lock.
func (s *InMemoryChannelStorage[T]) Acquire(_ context.Context, channelId string, pendingId string, ttlMs int64) (bool, error) {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	now := time.Now().UnixMilli()
	if current, ok := s.admissionLocks[key]; ok && current.ExpiresAt > now {
		return false, nil
	}
	s.admissionLocks[key] = admissionLock{PendingId: pendingId, ExpiresAt: now + ttlMs}
	return true, nil
}

// Release drops the admission lock only when pendingId still holds it.
func (s *InMemoryChannelStorage[T]) Release(_ context.Context, channelId string, pendingId string) error {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if current, ok := s.admissionLocks[key]; ok && current.PendingId == pendingId {
		delete(s.admissionLocks, key)
	}
	return nil
}

// IsHeld reports whether a live admission lock exists, optionally matching pendingId.
func (s *InMemoryChannelStorage[T]) IsHeld(_ context.Context, channelId string, pendingId string) (bool, error) {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.admissionLocks[key]
	if !ok || current.ExpiresAt <= time.Now().UnixMilli() {
		delete(s.admissionLocks, key)
		return false, nil
	}
	if pendingId == "" {
		return true, nil
	}
	return current.PendingId == pendingId, nil
}

func zeroRecord[T ChannelRecord[T]]() T {
	var zero T
	return zero
}

func isZeroRecord[T ChannelRecord[T]](v T) bool {
	var zero T
	return any(v) == any(zero)
}

func sameRecord[T ChannelRecord[T]](a, b T) bool {
	return any(a) == any(b)
}
