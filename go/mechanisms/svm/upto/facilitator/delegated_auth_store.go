package facilitator

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	x402 "github.com/x402-foundation/x402/go/v2"
)

// DelegatedAuthBinding is the deposit-time caller identity bound to a channel
// so a later claim settle can be correlated to the same service.
//
// Kept off the rent-cleanup channel record: that record is re-upserted at
// claim time and is repopulated from chain by Discover with no identity
// available.
type DelegatedAuthBinding struct {
	ChannelID string
	Network   x402.Network
	// CallerIdentity is the identity ResolveCallerIdentity returned on the deposit settle.
	CallerIdentity string
	// ExpiresAt is payload expiresAt (Unix seconds); entries past it are unusable.
	ExpiresAt int64
}

// ErrDelegatedAuthIdentityConflict is returned by Bind when a different
// CallerIdentity already owns the (channelID, network) key.
var ErrDelegatedAuthIdentityConflict = errors.New("delegated auth binding already exists for a different identity")

// DelegatedAuthStore is a pluggable store of delegated deposit/claim
// caller-identity bindings.
//
// Bind is keyed by (channelID, network) and is first-writer-wins:
//
//   - no existing row (or expired) → insert
//   - existing row, same CallerIdentity → success (idempotent retry after
//     bind-then-broadcast-fail)
//   - existing row, different CallerIdentity → ErrDelegatedAuthIdentityConflict
//
// Get should return (nil, nil) for not-found / expired and propagate store
// errors so a host can map infra failures separately from unauthenticated.
type DelegatedAuthStore interface {
	Bind(ctx context.Context, binding DelegatedAuthBinding) error
	Get(ctx context.Context, channelID string, network x402.Network) (*DelegatedAuthBinding, error)
	Delete(ctx context.Context, channelID string, network x402.Network) error
}

// InMemoryDelegatedAuthStore is the default DelegatedAuthStore. A multi-replica
// facilitator must inject a shared implementation; a lost binding fails closed.
type InMemoryDelegatedAuthStore struct {
	mu       sync.Mutex
	bindings map[string]DelegatedAuthBinding
}

// NewInMemoryDelegatedAuthStore creates an empty in-memory identity store.
func NewInMemoryDelegatedAuthStore() *InMemoryDelegatedAuthStore {
	return &InMemoryDelegatedAuthStore{bindings: make(map[string]DelegatedAuthBinding)}
}

func delegatedAuthBindingKey(channelID string, network x402.Network) string {
	return string(network) + ":" + channelID
}

func delegatedAuthExpired(expiresAt int64) bool {
	return expiresAt <= time.Now().Unix()
}

// Bind records the caller identity for a channel. First writer wins: a later
// Bind with the same identity is a no-op; a different identity is an error.
func (s *InMemoryDelegatedAuthStore) Bind(_ context.Context, binding DelegatedAuthBinding) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := delegatedAuthBindingKey(binding.ChannelID, binding.Network)
	existing, ok := s.bindings[key]
	if ok && !delegatedAuthExpired(existing.ExpiresAt) {
		if existing.CallerIdentity == binding.CallerIdentity {
			return nil
		}
		return fmt.Errorf("%w", ErrDelegatedAuthIdentityConflict)
	}
	s.bindings[key] = binding
	return nil
}

// Get looks up a binding. Entries at or past ExpiresAt are treated as absent.
func (s *InMemoryDelegatedAuthStore) Get(_ context.Context, channelID string, network x402.Network) (*DelegatedAuthBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	key := delegatedAuthBindingKey(channelID, network)
	binding, ok := s.bindings[key]
	if !ok {
		return nil, nil
	}
	if delegatedAuthExpired(binding.ExpiresAt) {
		delete(s.bindings, key)
		return nil, nil
	}
	copied := binding
	return &copied, nil
}

// Delete removes a binding.
func (s *InMemoryDelegatedAuthStore) Delete(_ context.Context, channelID string, network x402.Network) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.bindings, delegatedAuthBindingKey(channelID, network))
	return nil
}
