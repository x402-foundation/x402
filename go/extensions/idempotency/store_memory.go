package idempotency

import (
	"context"
	"sync"
	"time"

	x402 "github.com/coinbase/x402/go"
)

// InMemoryStore provides an in-memory implementation of SettlementStore.
//
// This implementation is suitable for single-instance deployments where
// cache state doesn't need to be shared across processes. For distributed
// deployments (load-balanced clusters, etc.), implement SettlementStore
// with a shared backend like Redis.
//
// Features:
//   - Thread-safe with mutex protection
//   - Configurable TTL for cached results
//   - In-flight request tracking with wait channels
//   - Lazy cleanup of expired entries
type InMemoryStore struct {
	mu       sync.Mutex
	results  map[string]*x402.SettleResponse
	expiry   map[string]time.Time
	inFlight map[string]chan struct{}
	ttl      time.Duration
}

// NewInMemoryStore creates a new in-memory settlement store with the specified TTL.
//
// The TTL determines how long successful settlement results are cached.
// Typical values are 5-15 minutes, balancing deduplication window size
// against memory usage.
func NewInMemoryStore(ttl time.Duration) *InMemoryStore {
	return &InMemoryStore{
		results:  make(map[string]*x402.SettleResponse),
		expiry:   make(map[string]time.Time),
		inFlight: make(map[string]chan struct{}),
		ttl:      ttl,
	}
}

// CheckAndMark atomically checks the cache and marks the key as in-flight if needed.
//
// Returns:
//   - StatusCached + result if a cached result exists and hasn't expired
//   - StatusInFlight + wait channel if another request is currently processing
//   - StatusNotFound + done channel if this request should proceed (now marked in-flight)
func (s *InMemoryStore) CheckAndMark(key string) (SettlementStatus, *x402.SettleResponse, chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check for cached result first
	if expiry, exists := s.expiry[key]; exists {
		if time.Now().Before(expiry) {
			if result, ok := s.results[key]; ok {
				return StatusCached, result, nil
			}
		}
		// Expired - clean it up
		delete(s.results, key)
		delete(s.expiry, key)
	}

	// Check if in-flight
	if done, exists := s.inFlight[key]; exists {
		return StatusInFlight, nil, done
	}

	// Mark as in-flight
	done := make(chan struct{})
	s.inFlight[key] = done
	return StatusNotFound, nil, done
}

// WaitForResult waits for an in-flight request to complete, respecting context cancellation.
//
// Returns:
//   - The cached result if available after the in-flight request completes
//   - nil if the in-flight request failed (no result was cached)
//   - Error if the context was cancelled before completion
func (s *InMemoryStore) WaitForResult(ctx context.Context, key string, done chan struct{}) (*x402.SettleResponse, error) {
	select {
	case <-done:
		// In-flight request completed, check for cached result
		return s.get(key), nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// get retrieves a cached settlement response if it exists and hasn't expired.
// Returns nil if not found or expired.
func (s *InMemoryStore) get(key string) *x402.SettleResponse {
	s.mu.Lock()
	defer s.mu.Unlock()

	expiry, exists := s.expiry[key]
	if !exists {
		return nil
	}

	if time.Now().After(expiry) {
		// Expired - clean it up
		delete(s.results, key)
		delete(s.expiry, key)
		return nil
	}

	return s.results[key]
}

// Complete marks a settlement as complete, caches the response,
// and signals any waiting goroutines.
func (s *InMemoryStore) Complete(key string, response *x402.SettleResponse, done chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Cache the result
	s.results[key] = response
	s.expiry[key] = time.Now().Add(s.ttl)

	// Remove from in-flight
	delete(s.inFlight, key)

	// Signal waiters
	close(done)

	// Lazy cleanup of expired entries
	s.cleanupExpiredLocked()
}

// Fail removes the in-flight marker without caching a result,
// allowing the settlement to be retried.
func (s *InMemoryStore) Fail(key string, done chan struct{}) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Remove from in-flight without caching
	delete(s.inFlight, key)

	// Signal waiters (they'll retry since no result cached)
	close(done)
}

// cleanupExpiredLocked removes expired entries. Must be called with lock held.
func (s *InMemoryStore) cleanupExpiredLocked() {
	now := time.Now()
	for key, expiry := range s.expiry {
		if now.After(expiry) {
			delete(s.results, key)
			delete(s.expiry, key)
		}
	}
}

// Ensure InMemoryStore implements SettlementStore
var _ SettlementStore = (*InMemoryStore)(nil)
