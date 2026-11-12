package casper

import (
	"sync"
	"time"
)

// SettlementCache records an authorization so callers can reject a second settle.
// Delete drops the key before broadcast; otherwise it expires at SettlementTTL.
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

// Delete removes a pending settlement key so a settle that failed before
// broadcasting can be retried before TTL.
func (c *SettlementCache) Delete(key string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	delete(c.entries, key)
}

// IsDuplicate reports whether key is already pending. A new key is recorded
// and returns false; callers reject the settlement when this returns true.
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

// prune removes entries older than the settlement TTL. Caller must hold mu.
func (c *SettlementCache) prune() {
	cutoff := time.Now().Add(-SettlementTTL)
	for key, ts := range c.entries {
		if ts.Before(cutoff) {
			delete(c.entries, key)
		}
	}
}
