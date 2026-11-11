package svm

import (
	"context"
	"sync"
	"time"
)

// DuplicateSettlementStore coalesces in-flight settlements of one operation
// across workers. A worker reserves an operation key with the signature of the
// transaction it is about to broadcast, after signing and before sending. A
// worker that loses the reservation reconciles against the holder's signature
// instead of broadcasting a second transaction.
//
// A reservation is a coalescing lock, not a result: it expires after ttl, once
// the blockhash can no longer land, and the chain answers from then on.
// Implementations must be safe for concurrent use.
type DuplicateSettlementStore interface {
	// Reserve records signature under key for ttl when key is free. When key
	// is held it returns the holder's signature and reserved=false.
	Reserve(ctx context.Context, key, signature string, ttl time.Duration) (existing string, reserved bool, err error)
	// Release removes key only while it still holds signature, so a failed
	// broadcast can be retried before ttl and a later holder is never evicted.
	Release(ctx context.Context, key, signature string) error
}

type reservation struct {
	signature string
	expiresAt time.Time
}

// InMemoryDuplicateSettlementStore is the process-local DuplicateSettlementStore.
type InMemoryDuplicateSettlementStore struct {
	mu      sync.Mutex
	entries map[string]reservation
	now     func() time.Time
}

// NewInMemoryDuplicateSettlementStore creates an empty in-memory store.
func NewInMemoryDuplicateSettlementStore() *InMemoryDuplicateSettlementStore {
	return &InMemoryDuplicateSettlementStore{
		entries: make(map[string]reservation),
		now:     time.Now,
	}
}

// Reserve implements DuplicateSettlementStore.
func (s *InMemoryDuplicateSettlementStore) Reserve(_ context.Context, key, signature string, ttl time.Duration) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := s.now()
	s.prune(now)
	if held, ok := s.entries[key]; ok {
		return held.signature, false, nil
	}
	s.entries[key] = reservation{signature: signature, expiresAt: now.Add(ttl)}
	return "", true, nil
}

// Release implements DuplicateSettlementStore.
func (s *InMemoryDuplicateSettlementStore) Release(_ context.Context, key, signature string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if held, ok := s.entries[key]; ok && held.signature == signature {
		delete(s.entries, key)
	}
	return nil
}

// prune removes expired reservations. Caller must hold mu.
func (s *InMemoryDuplicateSettlementStore) prune(now time.Time) {
	for key, held := range s.entries {
		if !held.expiresAt.After(now) {
			delete(s.entries, key)
		}
	}
}
