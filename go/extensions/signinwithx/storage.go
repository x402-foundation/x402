package signinwithx

import (
	"strings"
	"sync"
)

// Storage tracks which addresses have paid for which resources so SIWX can
// grant access without re-payment.
type Storage interface {
	HasPaid(resource, address string) bool
	RecordPayment(resource, address string)
}

// NonceStore is an optional capability for replay protection. A Storage that
// also implements it can reject reused nonces.
type NonceStore interface {
	HasUsedNonce(nonce string) bool
	RecordNonce(nonce string)
}

// InMemoryStorage implements Storage and NonceStore for development and
// single-instance deployments. Addresses are compared case-insensitively. For
// multi-instance deployments use a persistent implementation.
type InMemoryStorage struct {
	mu     sync.RWMutex
	paid   map[string]map[string]struct{}
	nonces map[string]struct{}
}

// NewInMemoryStorage returns an empty in-memory store.
func NewInMemoryStorage() *InMemoryStorage {
	return &InMemoryStorage{
		paid:   make(map[string]map[string]struct{}),
		nonces: make(map[string]struct{}),
	}
}

// HasPaid reports whether address has paid for resource.
func (s *InMemoryStorage) HasPaid(resource, address string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	addrs, ok := s.paid[resource]
	if !ok {
		return false
	}
	_, ok = addrs[strings.ToLower(address)]
	return ok
}

// RecordPayment records that address has paid for resource.
func (s *InMemoryStorage) RecordPayment(resource, address string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.paid[resource] == nil {
		s.paid[resource] = make(map[string]struct{})
	}
	s.paid[resource][strings.ToLower(address)] = struct{}{}
}

// HasUsedNonce reports whether nonce has been recorded.
func (s *InMemoryStorage) HasUsedNonce(nonce string) bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	_, ok := s.nonces[nonce]
	return ok
}

// RecordNonce marks nonce as used.
func (s *InMemoryStorage) RecordNonce(nonce string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nonces[nonce] = struct{}{}
}
