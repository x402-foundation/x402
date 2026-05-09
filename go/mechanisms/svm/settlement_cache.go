package svm

import (
	"sync"
	"time"
)

// SettlementCache is a thread-safe in-memory cache for deduplicating concurrent
// settlement requests.  A single instance should be shared across V1 and V2
// facilitator scheme instances so that a transaction submitted through one
// protocol version is also blocked on the other.
type SettlementCache struct {
	mu      sync.Mutex
	entries map[string]time.Time
}

// NewSettlementCache creates a new, empty SettlementCache.
func NewSettlementCache() *SettlementCache {
	return &SettlementCache{
		entries: make(map[string]time.Time),
	}
}

// IsDuplicate returns true if key is already pending settlement (duplicate).
// Otherwise it records the key as newly pending and returns false.
// Callers should reject the settlement when this returns true.
func (c *SettlementCache) IsDuplicate(key string) bool {
	c.mu.Lock()
	defer c.mu.Unlock()

	c.prune()

	if _, exists := c.entries[key]; exists {
		return true
	}
	c.entries[key] = time.Now()
	return false
}

// Entries returns a snapshot of the underlying map — use only in tests.
func (c *SettlementCache) Entries() map[string]time.Time {
	return c.entries
}

// Mu returns the mutex — use only in tests.
func (c *SettlementCache) Mu() *sync.Mutex {
	return &c.mu
}

// prune removes entries older than the settlement TTL. Caller must hold mu.
func (c *SettlementCache) prune() {
	cutoff := time.Now().Add(-SettlementTTL)
	for key, ts := range c.entries {
		if ts.Before(cutoff) {
			delete(c.entries, key)
		}
	}
}
