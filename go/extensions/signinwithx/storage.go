package signinwithx

import (
	"context"
	"strings"
	"sync"
)

// Storage tracks SIWX payment and optional nonce state.
type Storage interface {
	HasPaid(ctx context.Context, resource string, address string) (bool, error)
	RecordPayment(ctx context.Context, resource string, address string) error
}

// NonceStorage is implemented by Storage backends that prevent nonce reuse.
type NonceStorage interface {
	HasUsedNonce(ctx context.Context, nonce string) (bool, error)
	RecordNonce(ctx context.Context, nonce string) error
}

// InMemoryStorage is a process-local SIWX storage implementation.
type InMemoryStorage struct {
	mu     sync.RWMutex
	paid   map[string]map[string]struct{}
	nonces map[string]struct{}
}

// NewInMemoryStorage creates an empty in-memory SIWX storage backend.
func NewInMemoryStorage() *InMemoryStorage {
	return &InMemoryStorage{
		paid:   make(map[string]map[string]struct{}),
		nonces: make(map[string]struct{}),
	}
}

// HasPaid reports whether address has paid for resource.
func (s *InMemoryStorage) HasPaid(_ context.Context, resource string, address string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	addresses := s.paid[resource]
	if addresses == nil {
		return false, nil
	}
	_, ok := addresses[normalizeAddress(address)]
	return ok, nil
}

// RecordPayment records address as paid for resource.
func (s *InMemoryStorage) RecordPayment(_ context.Context, resource string, address string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.paid[resource] == nil {
		s.paid[resource] = make(map[string]struct{})
	}
	s.paid[resource][normalizeAddress(address)] = struct{}{}
	return nil
}

// HasUsedNonce reports whether nonce was already accepted.
func (s *InMemoryStorage) HasUsedNonce(_ context.Context, nonce string) (bool, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()

	_, ok := s.nonces[nonce]
	return ok, nil
}

// RecordNonce marks nonce as accepted.
func (s *InMemoryStorage) RecordNonce(_ context.Context, nonce string) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	s.nonces[nonce] = struct{}{}
	return nil
}

func normalizeAddress(address string) string {
	if strings.HasPrefix(address, "0x") || strings.HasPrefix(address, "0X") {
		return strings.ToLower(address)
	}
	return address
}
