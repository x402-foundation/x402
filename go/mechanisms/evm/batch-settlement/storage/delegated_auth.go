package storage

import (
	"context"
	"strings"
	"sync"
)

// DelegatedAuthBinding is a deposit-time caller identity bound to a channel
// so a later refund settle can be correlated to the same service.
type DelegatedAuthBinding struct {
	ChannelId      string
	Network        string
	CallerIdentity string
	Receiver       string
	// OpenToken identifies the deposit that created the binding. Get does not return it.
	OpenToken string
}

// DelegatedAuthIdentityConflictError is returned by Bind when a different
// identity already owns the (channelId, network) key.
type DelegatedAuthIdentityConflictError struct{}

func (e *DelegatedAuthIdentityConflictError) Error() string {
	return "delegated auth binding already exists for a different identity"
}

// DelegatedAuthStore persists delegated deposit/refund caller-identity bindings.
// The SDK removes a binding only through RevertBind, after the deposit that created it failed.
// Bind is durable; nil means a later Get sees the row. Do not broadcast before that.
type DelegatedAuthStore interface {
	// Bind is first-writer-wins. created is true only when this call inserted the row.
	// Same identity on an existing row returns created == false and clears its open
	// token; a different identity conflicts and leaves the row untouched.
	Bind(ctx context.Context, binding DelegatedAuthBinding) (created bool, err error)
	Get(ctx context.Context, channelId string, network string) (*DelegatedAuthBinding, error)
	// RevertBind deletes the binding only when openToken is non-empty and matches.
	RevertBind(ctx context.Context, channelId string, network string, openToken string) error
}

// InMemoryDelegatedAuthStore is a volatile DelegatedAuthStore. A multi-replica
// facilitator must inject a shared implementation; a lost binding fails closed.
type InMemoryDelegatedAuthStore struct {
	mu       sync.Mutex
	bindings map[string]DelegatedAuthBinding
}

var _ DelegatedAuthStore = (*InMemoryDelegatedAuthStore)(nil)

// NewInMemoryDelegatedAuthStore creates an empty in-memory binding store.
func NewInMemoryDelegatedAuthStore() *InMemoryDelegatedAuthStore {
	return &InMemoryDelegatedAuthStore{bindings: make(map[string]DelegatedAuthBinding)}
}

func (s *InMemoryDelegatedAuthStore) Bind(_ context.Context, binding DelegatedAuthBinding) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	key := bindingKey(binding.ChannelId, binding.Network)
	existing, ok := s.bindings[key]
	if !ok {
		s.bindings[key] = binding
		return true, nil
	}
	if existing.CallerIdentity != binding.CallerIdentity {
		return false, &DelegatedAuthIdentityConflictError{}
	}
	existing.OpenToken = ""
	s.bindings[key] = existing
	return false, nil
}

// Get returns a copy without the open token.
func (s *InMemoryDelegatedAuthStore) Get(_ context.Context, channelId string, network string) (*DelegatedAuthBinding, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	binding, ok := s.bindings[bindingKey(channelId, network)]
	if !ok {
		return nil, nil
	}
	binding.OpenToken = ""
	return &binding, nil
}

func (s *InMemoryDelegatedAuthStore) RevertBind(_ context.Context, channelId string, network string, openToken string) error {
	if openToken == "" {
		return nil
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	key := bindingKey(channelId, network)
	if existing, ok := s.bindings[key]; ok && existing.OpenToken == openToken {
		delete(s.bindings, key)
	}
	return nil
}

func bindingKey(channelId string, network string) string {
	return network + ":" + strings.ToLower(channelId)
}
