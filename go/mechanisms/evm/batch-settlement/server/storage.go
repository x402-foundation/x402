package server

import (
	"sync"
	"time"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// ChannelSession holds per-channel session state on the server side.
type ChannelSession struct {
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
	// OnchainSyncedAt is the wall-clock time (unix millis) when balance/totalClaimed/
	// withdrawRequestedAt/refundNonce were last refreshed from onchain state.
	// Used by the local voucher verifier to decide whether to skip facilitator verify.
	OnchainSyncedAt int64 `json:"onchainSyncedAt,omitempty"`
}

// ChannelUpdateStatus describes the outcome of an UpdateChannel call.
type ChannelUpdateStatus string

const (
	ChannelUpdated   ChannelUpdateStatus = "updated"
	ChannelUnchanged ChannelUpdateStatus = "unchanged"
	ChannelDeleted   ChannelUpdateStatus = "deleted"
)

// ChannelUpdateResult is the result of an UpdateChannel call.
type ChannelUpdateResult struct {
	Channel *ChannelSession
	Status  ChannelUpdateStatus
}

// SessionStorage is the interface for persisting server-side channel sessions.
type SessionStorage interface {
	Get(channelId string) (*ChannelSession, error)
	Set(channelId string, session *ChannelSession) error
	Delete(channelId string) error
	List() ([]*ChannelSession, error)
	// CompareAndSet atomically updates a session only if the current
	// chargedCumulativeAmount matches expectedCharged. Returns true if the
	// swap succeeded, false if the value changed underneath (concurrent request).
	//
	// Deprecated: prefer UpdateChannel for richer atomic mutations.
	CompareAndSet(channelId string, expectedCharged string, session *ChannelSession) (bool, error)
	// UpdateChannel atomically inspects and mutates a channel record.
	// The update callback receives the current session (or nil) and returns
	// the next session (or nil to delete). Returning the unchanged input is
	// a no-op (status: unchanged). The implementation must guarantee no
	// concurrent mutation can interleave between read and write.
	UpdateChannel(channelId string, update func(current *ChannelSession) *ChannelSession) (*ChannelUpdateResult, error)
}

// ChannelLockStorage is a best-effort per-channel admission lock. Loss or
// unavailability degrades to optimistic mode: the durable charge CAS still
// serializes commits.
type ChannelLockStorage interface {
	// Acquire is SET NX + TTL. Value is pendingId. Expired keys are free.
	Acquire(channelId string, pendingId string, ttlMs int64) (bool, error)
	// Release is compare-and-delete: releases only when pendingId still holds.
	Release(channelId string, pendingId string) error
	// IsHeld reports any live lock, or this pendingId when provided (empty
	// pendingId means any live lock).
	IsHeld(channelId string, pendingId string) (bool, error)
}

type admissionLock struct {
	PendingId string `json:"pendingId"`
	ExpiresAt int64  `json:"expiresAt"`
}

// InMemoryChannelStorage is a volatile in-memory implementation of SessionStorage.
//
// Note on unbounded growth: the per-channel lock map is allocated lazily and
// dropped when Delete is called for that channel. For long-lived servers that
// see an effectively unbounded set of distinct channelIds without ever calling
// Delete, this map will grow over time. Production deployments backed by a
// persistent store (e.g. FileChannelStorage) should prefer Delete-on-drain.
type InMemoryChannelStorage struct {
	mu             sync.Mutex
	sessions       map[string]*ChannelSession
	locks          map[string]*sync.Mutex // per-channel locks for UpdateChannel
	admissionLocks map[string]admissionLock
}

// NewInMemoryChannelStorage creates a new in-memory server session storage.
func NewInMemoryChannelStorage() *InMemoryChannelStorage {
	return &InMemoryChannelStorage{
		sessions:       make(map[string]*ChannelSession),
		locks:          make(map[string]*sync.Mutex),
		admissionLocks: make(map[string]admissionLock),
	}
}

func (s *InMemoryChannelStorage) lockFor(channelId string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock, ok := s.locks[channelId]
	if !ok {
		lock = &sync.Mutex{}
		s.locks[channelId] = lock
	}
	return lock
}

func (s *InMemoryChannelStorage) Get(channelId string) (*ChannelSession, error) {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[key]
	if !ok {
		return nil, nil
	}
	cp := *session
	return &cp, nil
}

func (s *InMemoryChannelStorage) Set(channelId string, session *ChannelSession) error {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *session
	s.sessions[key] = &cp
	return nil
}

func (s *InMemoryChannelStorage) Delete(channelId string) error {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, key)
	// NOTE: the per-channel lock entry is intentionally retained. Removing it
	// would let a stale lockFor caller (already holding the old *sync.Mutex)
	// race with a fresh caller (allocating a new *sync.Mutex) for the same
	// channelId. The lock map grows monotonically with the channel-id set;
	// see the type-level note.
	return nil
}

func (s *InMemoryChannelStorage) List() ([]*ChannelSession, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	result := make([]*ChannelSession, 0, len(s.sessions))
	for _, session := range s.sessions {
		cp := *session
		result = append(result, &cp)
	}
	return result, nil
}

func (s *InMemoryChannelStorage) CompareAndSet(channelId string, expectedCharged string, session *ChannelSession) (bool, error) {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return false, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.sessions[key]
	if ok && current.ChargedCumulativeAmount != expectedCharged {
		return false, nil
	}
	cp := *session
	s.sessions[key] = &cp
	return true, nil
}

func (s *InMemoryChannelStorage) UpdateChannel(channelId string, update func(current *ChannelSession) *ChannelSession) (*ChannelUpdateResult, error) {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return nil, err
	}
	lock := s.lockFor(key)
	lock.Lock()
	defer lock.Unlock()

	s.mu.Lock()
	current, exists := s.sessions[key]
	var currentCopy *ChannelSession
	if exists {
		cp := *current
		currentCopy = &cp
	}
	s.mu.Unlock()

	next := update(currentCopy)

	// "unchanged" means the callback returned the same pointer it received.
	if next == currentCopy {
		return &ChannelUpdateResult{Channel: currentCopy, Status: ChannelUnchanged}, nil
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if next == nil {
		if exists {
			delete(s.sessions, key)
			return &ChannelUpdateResult{Channel: nil, Status: ChannelDeleted}, nil
		}
		return &ChannelUpdateResult{Channel: nil, Status: ChannelUnchanged}, nil
	}
	cp := *next
	s.sessions[key] = &cp
	stored := cp
	return &ChannelUpdateResult{Channel: &stored, Status: ChannelUpdated}, nil
}

func (s *InMemoryChannelStorage) Acquire(channelId string, pendingId string, ttlMs int64) (bool, error) {
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

func (s *InMemoryChannelStorage) Release(channelId string, pendingId string) error {
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

func (s *InMemoryChannelStorage) IsHeld(channelId string, pendingId string) (bool, error) {
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
