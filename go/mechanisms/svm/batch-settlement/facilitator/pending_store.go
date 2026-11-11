package facilitator

import (
	"context"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// PendingRetention is how long the default PendingSettlementStore keeps an entry.
// With OnDistributionConfirmed set, it bounds how long a failing hook can still be
// replayed its payout. x402.NewInMemoryPendingSettlementStore keeps entries only
// five minutes.
const PendingRetention = 24 * time.Hour

type retainedEntry struct {
	value    string
	storedAt time.Time
}

// retainedPendingStore is the process-local default PendingSettlementStore.
type retainedPendingStore struct {
	mu      sync.Mutex
	entries map[string]retainedEntry
	now     func() time.Time
}

var _ x402.PendingSettlementStore = (*retainedPendingStore)(nil)

func newRetainedPendingStore() *retainedPendingStore {
	return &retainedPendingStore{entries: make(map[string]retainedEntry), now: time.Now}
}

func (s *retainedPendingStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	entry, ok := s.entries[key]
	return entry.value, ok, nil
}

func (s *retainedPendingStore) Set(_ context.Context, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.prune()
	s.entries[key] = retainedEntry{value: value, storedAt: s.now()}
	return nil
}

func (s *retainedPendingStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, key)
	return nil
}

// prune removes entries older than PendingRetention. Caller must hold mu.
func (s *retainedPendingStore) prune() {
	cutoff := s.now().Add(-PendingRetention)
	for key, entry := range s.entries {
		if entry.storedAt.Before(cutoff) {
			delete(s.entries, key)
		}
	}
}
