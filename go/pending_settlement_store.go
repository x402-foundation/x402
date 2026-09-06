package x402

import (
	"context"
	"sync"
	"time"
)

// PendingSettlementTTL is the TTL applied by the default in-memory
// PendingSettlementStore implementation. A store implementation backed by a
// different mechanism (e.g. Redis, for a multi-instance facilitator) is free
// to use its own TTL — this constant only governs InMemoryPendingSettlementStore.
const PendingSettlementTTL = 5 * time.Minute

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
// performs network I/O — Get additionally prunes expired entries (O(n) in
// the number of currently-stored entries, which stays small since entries
// only exist while a settlement is genuinely pending), so every call adds no
// meaningful latency to the settle hot path. Suitable for single-instance
// facilitators; multi-instance deployments should inject a shared,
// network-backed PendingSettlementStore implementation instead (e.g. Redis).
type InMemoryPendingSettlementStore struct {
	mu      sync.Mutex
	entries map[string]pendingSettlementEntry
}

// NewInMemoryPendingSettlementStore creates a new, empty
// InMemoryPendingSettlementStore.
func NewInMemoryPendingSettlementStore() *InMemoryPendingSettlementStore {
	return &InMemoryPendingSettlementStore{
		entries: make(map[string]pendingSettlementEntry),
	}
}

// Get implements PendingSettlementStore.
func (s *InMemoryPendingSettlementStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.prune()

	entry, ok := s.entries[key]
	if !ok {
		return "", false, nil
	}
	return entry.txHash, true, nil
}

// Set implements PendingSettlementStore.
func (s *InMemoryPendingSettlementStore) Set(_ context.Context, key string, txHash string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.entries[key] = pendingSettlementEntry{txHash: txHash, storedAt: time.Now()}
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

// prune removes entries older than PendingSettlementTTL. Caller must hold mu.
func (s *InMemoryPendingSettlementStore) prune() {
	cutoff := time.Now().Add(-PendingSettlementTTL)
	for key, entry := range s.entries {
		if entry.storedAt.Before(cutoff) {
			delete(s.entries, key)
		}
	}
}
