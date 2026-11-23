package x402

import (
	"context"
	"sync"
	"time"
)

// PendingSettlementTTL is the TTL applied by the default in-memory
// PendingSettlementStore implementation. A store implementation backed by a
// different mechanism (e.g. Redis, for a multi-instance facilitator) is free
// to use its own TTL — this constant only governs InMemoryPendingSettlementStore,
// and WithPendingSettlementTTL overrides it per store.
const PendingSettlementTTL = 5 * time.Minute

// pendingSettlementSweepInterval bounds how often Set sweeps expired entries,
// so Get and Set cost one lookup rather than a scan of the map.
const pendingSettlementSweepInterval = time.Minute

// PendingSettlementStore lets a facilitator-side mechanism remember a
// broadcast-but-not-yet-confirmed transaction hash, keyed by a deterministic
// identifier derived from the payment payload (e.g. an EIP-3009/Permit2
// signature, or an SVM message hash). When a settle attempt's receipt/
// confirmation wait fails, the mechanism stores the broadcast hash here before
// returning a `settlement_pending` error. On a subsequent settle attempt for
// the same payload (typically the resource server's single automatic retry —
// see x402ResourceServer.settle), the mechanism checks this store first and,
// on a hit, reconciles against the already-broadcast transaction instead of
// verifying and broadcasting a second one.
//
// This is an interface — not a concrete type — specifically so a
// multi-instance facilitator (running several replicas with no session
// affinity) can supply a shared, network-backed implementation (e.g. Redis)
// instead of the in-memory default, which only works when a retry happens to
// land back on the same process. Implementations must be safe for concurrent
// use.
type PendingSettlementStore interface {
	// Get returns the previously stored transaction hash for key, if any.
	// ok is false when there is no entry (including one that has expired).
	Get(ctx context.Context, key string) (txHash string, ok bool, err error)
	// Set records that key's payment broadcast txHash but has not yet been
	// confirmed. A subsequent Set for the same key overwrites the prior value.
	Set(ctx context.Context, key string, txHash string) error
	// Delete removes any pending entry for key, e.g. once the transaction is
	// confirmed (success) or the mechanism determines it terminally failed.
	Delete(ctx context.Context, key string) error
}

// pendingSettlementEntry is a single InMemoryPendingSettlementStore record.
type pendingSettlementEntry struct {
	txHash   string
	storedAt time.Time
}

// InMemoryPendingSettlementStore is the default PendingSettlementStore
// implementation: a mutex-protected, per-process map with lazy TTL pruning
// (mirrors the shape of go/mechanisms/svm/settlement_cache.go). It never
// performs network I/O — Get checks only the requested entry's age and Set
// sweeps the whole map at most once per minute, so every call adds no
// meaningful latency to the settle hot path. Suitable for single-instance
// facilitators; multi-instance deployments should inject a shared,
// network-backed PendingSettlementStore implementation instead (e.g. Redis).
type InMemoryPendingSettlementStore struct {
	mu        sync.Mutex
	entries   map[string]pendingSettlementEntry
	ttl       time.Duration
	lastSwept time.Time
}

// InMemoryPendingSettlementStoreOption configures an InMemoryPendingSettlementStore.
type InMemoryPendingSettlementStoreOption func(*InMemoryPendingSettlementStore)

// WithPendingSettlementTTL sets how long the store keeps an entry, in place of PendingSettlementTTL.
func WithPendingSettlementTTL(ttl time.Duration) InMemoryPendingSettlementStoreOption {
	return func(s *InMemoryPendingSettlementStore) {
		s.ttl = ttl
	}
}

// NewInMemoryPendingSettlementStore creates a new, empty
// InMemoryPendingSettlementStore.
func NewInMemoryPendingSettlementStore(opts ...InMemoryPendingSettlementStoreOption) *InMemoryPendingSettlementStore {
	s := &InMemoryPendingSettlementStore{
		entries: make(map[string]pendingSettlementEntry),
		ttl:     PendingSettlementTTL,
	}
	for _, opt := range opts {
		opt(s)
	}
	return s
}

// Get implements PendingSettlementStore.
func (s *InMemoryPendingSettlementStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	entry, ok := s.entries[key]
	if !ok {
		return "", false, nil
	}
	if s.expired(entry, time.Now()) {
		delete(s.entries, key)
		return "", false, nil
	}
	return entry.txHash, true, nil
}

// Set implements PendingSettlementStore.
func (s *InMemoryPendingSettlementStore) Set(_ context.Context, key string, txHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	now := time.Now()
	s.sweep(now)
	s.entries[key] = pendingSettlementEntry{txHash: txHash, storedAt: now}
	return nil
}

// Delete implements PendingSettlementStore.
func (s *InMemoryPendingSettlementStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.entries, key)
	return nil
}

// Entries returns a snapshot of the underlying map — use only in tests.
func (s *InMemoryPendingSettlementStore) Entries() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()

	out := make(map[string]string, len(s.entries))
	for k, v := range s.entries {
		out[k] = v.txHash
	}
	return out
}

func (s *InMemoryPendingSettlementStore) expired(entry pendingSettlementEntry, now time.Time) bool {
	return entry.storedAt.Before(now.Add(-s.ttl))
}

// sweep removes entries older than the store's TTL at most once per
// pendingSettlementSweepInterval. Caller must hold mu.
func (s *InMemoryPendingSettlementStore) sweep(now time.Time) {
	if now.Sub(s.lastSwept) < pendingSettlementSweepInterval {
		return
	}
	s.lastSwept = now
	for key, entry := range s.entries {
		if s.expired(entry, now) {
			delete(s.entries, key)
		}
	}
}
