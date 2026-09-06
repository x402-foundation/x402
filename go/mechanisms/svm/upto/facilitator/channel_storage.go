package facilitator

import (
	"context"
	"sync"
	"time"
)

// ChannelRecord holds the payment-channel facts rent cleanup needs and the
// channel account itself cannot provide: the distribution preimage (payTo),
// the token program, the abandon-policy timestamps, and the network.
// Payer, payee, mint, openSlot, and status are always read live before acting.
//
// Written on deposit settle (before broadcast) and on claim settle; deleted
// once the PDA is gone.
type ChannelRecord struct {
	ChannelID string
	// PayTo is the distribution recipient sealed at open.
	PayTo        string
	TokenProgram string
	// FirstSeenAt is when the facilitator first stored this channel.
	FirstSeenAt time.Time
	// ExpiresAt is the client voucher expiry (Unix seconds). It never shrinks
	// on a later upsert.
	ExpiresAt int64
	Network   string
}

// ChannelStorage persists the channels a facilitator sponsors rent for.
// Implementations must be safe for concurrent use; inject a durable one for
// multi-process facilitators.
type ChannelStorage interface {
	Get(ctx context.Context, channelID string) (*ChannelRecord, error)
	// List returns every stored record, in any order. The rent cleanup manager
	// sorts by channel ID before scanning, so implementations do not have to.
	List(ctx context.Context) ([]ChannelRecord, error)
	Upsert(ctx context.Context, record ChannelRecord) error
	Delete(ctx context.Context, channelID string) error
}

// InMemoryChannelStorage is the default ChannelStorage. It keeps the earliest
// FirstSeenAt and the latest ExpiresAt across upserts of the same channel.
type InMemoryChannelStorage struct {
	mu       sync.RWMutex
	channels map[string]ChannelRecord
}

// NewInMemoryChannelStorage creates an empty in-memory channel store.
func NewInMemoryChannelStorage() *InMemoryChannelStorage {
	return &InMemoryChannelStorage{channels: make(map[string]ChannelRecord)}
}

// Get returns a stored channel, or nil when the channel is not tracked.
func (s *InMemoryChannelStorage) Get(_ context.Context, channelID string) (*ChannelRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	record, ok := s.channels[channelID]
	if !ok {
		return nil, nil
	}
	return &record, nil
}

// List returns every stored channel record.
func (s *InMemoryChannelStorage) List(_ context.Context) ([]ChannelRecord, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	records := make([]ChannelRecord, 0, len(s.channels))
	for _, record := range s.channels {
		records = append(records, record)
	}
	return records, nil
}

// Upsert inserts or replaces a record, preserving the original FirstSeenAt and
// the longest ExpiresAt seen for the channel.
func (s *InMemoryChannelStorage) Upsert(_ context.Context, record ChannelRecord) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if existing, ok := s.channels[record.ChannelID]; ok {
		record.FirstSeenAt = existing.FirstSeenAt
		if existing.ExpiresAt > record.ExpiresAt {
			record.ExpiresAt = existing.ExpiresAt
		}
	}
	s.channels[record.ChannelID] = record
	return nil
}

// Delete removes a channel from storage.
func (s *InMemoryChannelStorage) Delete(_ context.Context, channelID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	delete(s.channels, channelID)
	return nil
}
