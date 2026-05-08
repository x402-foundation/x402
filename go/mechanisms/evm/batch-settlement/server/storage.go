package server

import (
	"sync"

	batchsettlement "github.com/x402-foundation/x402/go/mechanisms/evm/batch-settlement"
)

// PendingRequest reserves a channel against concurrent same-channel requests.
// A request is allowed when no live (unexpired) pending entry exists. Cleanup
// hooks clear the reservation; the bounded TTL guarantees release if cleanup
// never runs.
type PendingRequest struct {
	PendingId          string `json:"pendingId"`
	SignedMaxClaimable string `json:"signedMaxClaimable"`
	ExpiresAt          int64  `json:"expiresAt"` // unix millis
}

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
	// PendingRequest is the in-flight reservation for this channel, if any.
	PendingRequest *PendingRequest `json:"pendingRequest,omitempty"`
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

// InMemoryChannelStorage is a volatile in-memory implementation of SessionStorage.
//
// Note on unbounded growth: the per-channel lock map is allocated lazily and
// dropped when Delete is called for that channel. For long-lived servers that
// see an effectively unbounded set of distinct channelIds without ever calling
// Delete, this map will grow over time. Production deployments backed by a
// persistent store (e.g. FileChannelStorage) should prefer Delete-on-drain.
type InMemoryChannelStorage struct {
	mu       sync.Mutex
	sessions map[string]*ChannelSession
	locks    map[string]*sync.Mutex // per-channel locks for UpdateChannel
}

// NewInMemoryChannelStorage creates a new in-memory server session storage.
func NewInMemoryChannelStorage() *InMemoryChannelStorage {
	return &InMemoryChannelStorage{
		sessions: make(map[string]*ChannelSession),
		locks:    make(map[string]*sync.Mutex),
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
	s.mu.Lock()
	defer s.mu.Unlock()
	session, ok := s.sessions[channelId]
	if !ok {
		return nil, nil
	}
	cp := *session
	return &cp, nil
}

func (s *InMemoryChannelStorage) Set(channelId string, session *ChannelSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	cp := *session
	s.sessions[channelId] = &cp
	return nil
}

func (s *InMemoryChannelStorage) Delete(channelId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, channelId)
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
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.sessions[channelId]
	if ok && current.ChargedCumulativeAmount != expectedCharged {
		return false, nil
	}
	cp := *session
	s.sessions[channelId] = &cp
	return true, nil
}

func (s *InMemoryChannelStorage) UpdateChannel(channelId string, update func(current *ChannelSession) *ChannelSession) (*ChannelUpdateResult, error) {
	lock := s.lockFor(channelId)
	lock.Lock()
	defer lock.Unlock()

	s.mu.Lock()
	current, exists := s.sessions[channelId]
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
			delete(s.sessions, channelId)
			return &ChannelUpdateResult{Channel: nil, Status: ChannelDeleted}, nil
		}
		return &ChannelUpdateResult{Channel: nil, Status: ChannelUnchanged}, nil
	}
	cp := *next
	s.sessions[channelId] = &cp
	stored := cp
	return &ChannelUpdateResult{Channel: &stored, Status: ChannelUpdated}, nil
}
