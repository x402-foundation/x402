package hedera

import (
	"sync"
	"time"
)

type settlementState int

const (
	settlementInFlight settlementState = iota + 1
	settlementSettled
)

type settlementEntry struct {
	state     settlementState
	expiresAt time.Time
}

// SettlementTracker tracks in-flight and settled Hedera transaction IDs.
// The default SettlementCache is process-local; multi-replica facilitators must
// inject a shared implementation (or run a single settler) to avoid double-settle.
type SettlementTracker interface {
	Seen(transactionID string) bool
	TryClaim(transactionID string) bool
	Confirm(transactionID string)
	Release(transactionID string)
}

// SettlementCache is an in-memory SettlementTracker with SettlementTTL expiry.
type SettlementCache struct {
	mu   sync.Mutex
	ttl  time.Duration
	now  func() time.Time
	seen map[string]settlementEntry
}

// NewSettlementCache creates an empty in-memory settlement cache.
func NewSettlementCache() *SettlementCache {
	return &SettlementCache{
		ttl:  SettlementTTL,
		now:  time.Now,
		seen: make(map[string]settlementEntry),
	}
}

var _ SettlementTracker = (*SettlementCache)(nil)

func (c *SettlementCache) purgeLocked(now time.Time) {
	for id, entry := range c.seen {
		if !entry.expiresAt.After(now) {
			delete(c.seen, id)
		}
	}
}

// Seen reports whether transactionID is in-flight or already settled.
func (c *SettlementCache) Seen(transactionID string) bool {
	if c == nil || transactionID == "" {
		return false
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	c.purgeLocked(now)
	_, ok := c.seen[transactionID]
	return ok
}

// TryClaim reserves transactionID for settlement. Returns false if already claimed or settled.
func (c *SettlementCache) TryClaim(transactionID string) bool {
	if c == nil || transactionID == "" {
		return true
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	c.purgeLocked(now)
	if _, ok := c.seen[transactionID]; ok {
		return false
	}
	c.seen[transactionID] = settlementEntry{
		state:     settlementInFlight,
		expiresAt: now.Add(c.ttl),
	}
	return true
}

// Confirm marks a claimed transactionID as settled.
func (c *SettlementCache) Confirm(transactionID string) {
	if c == nil || transactionID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	c.purgeLocked(now)
	c.seen[transactionID] = settlementEntry{
		state:     settlementSettled,
		expiresAt: now.Add(c.ttl),
	}
}

// Release drops an in-flight claim after a failed settle so a retry can proceed.
// Settled entries are left intact.
func (c *SettlementCache) Release(transactionID string) {
	if c == nil || transactionID == "" {
		return
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	c.purgeLocked(now)
	if entry, ok := c.seen[transactionID]; ok && entry.state == settlementInFlight {
		delete(c.seen, transactionID)
	}
}
