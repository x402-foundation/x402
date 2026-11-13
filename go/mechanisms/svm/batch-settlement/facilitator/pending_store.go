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

// retainedSweepInterval bounds how often the default store sweeps expired
// entries, so Get and Set cost one lookup rather than a scan of the retained history.
const retainedSweepInterval = time.Minute

type retainedEntry struct {
	value    string
	storedAt time.Time
}

// retainedPendingStore is the process-local default PendingSettlementStore.
type retainedPendingStore struct {
	mu        sync.Mutex
	entries   map[string]retainedEntry
	now       func() time.Time
	lastSwept time.Time
}

var _ x402.PendingSettlementStore = (*retainedPendingStore)(nil)

func newRetainedPendingStore() *retainedPendingStore {
	return &retainedPendingStore{entries: make(map[string]retainedEntry), now: time.Now}
}

func (s *retainedPendingStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	entry, ok := s.entries[key]
	if !ok {
		return "", false, nil
	}
	if entry.expired(s.now()) {
		delete(s.entries, key)
		return "", false, nil
	}
	return entry.value, true, nil
}

func (s *retainedPendingStore) Set(_ context.Context, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := s.now()
	s.sweep(now)
	s.entries[key] = retainedEntry{value: value, storedAt: now}
	return nil
}

func (s *retainedPendingStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.entries, key)
	return nil
}

func (e retainedEntry) expired(now time.Time) bool {
	return e.storedAt.Before(now.Add(-PendingRetention))
}

// sweep removes entries older than PendingRetention at most once per
// retainedSweepInterval. Caller must hold mu.
func (s *retainedPendingStore) sweep(now time.Time) {
	if now.Sub(s.lastSwept) < retainedSweepInterval {
		return
	}
	s.lastSwept = now
	for key, entry := range s.entries {
		if entry.expired(now) {
			delete(s.entries, key)
		}
	}
}
