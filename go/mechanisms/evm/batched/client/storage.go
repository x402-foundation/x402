package client

import (
	"sync"
)

// BatchedClientContext holds per-channel session state on the client side.
type BatchedClientContext struct {
	ChargedCumulativeAmount string `json:"chargedCumulativeAmount"`
	Balance                 string `json:"balance"`
	TotalClaimed            string `json:"totalClaimed"`
	DepositAmount           string `json:"depositAmount,omitempty"`
	SignedMaxClaimable      string `json:"signedMaxClaimable,omitempty"`
	Signature               string `json:"signature,omitempty"`
}

// ClientSessionStorage is the interface for persisting client-side channel sessions.
type ClientSessionStorage interface {
	Get(channelId string) (*BatchedClientContext, error)
	Set(channelId string, ctx *BatchedClientContext) error
	Delete(channelId string) error
}

// InMemoryClientSessionStorage is a volatile in-memory implementation of ClientSessionStorage.
type InMemoryClientSessionStorage struct {
	mu       sync.RWMutex
	sessions map[string]*BatchedClientContext
}

// NewInMemoryClientSessionStorage creates a new in-memory client session storage.
func NewInMemoryClientSessionStorage() *InMemoryClientSessionStorage {
	return &InMemoryClientSessionStorage{
		sessions: make(map[string]*BatchedClientContext),
	}
}

func (s *InMemoryClientSessionStorage) Get(channelId string) (*BatchedClientContext, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	ctx, ok := s.sessions[channelId]
	if !ok {
		return nil, nil
	}
	// Return a copy
	copy := *ctx
	return &copy, nil
}

func (s *InMemoryClientSessionStorage) Set(channelId string, ctx *BatchedClientContext) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := *ctx
	s.sessions[channelId] = &copy
	return nil
}

func (s *InMemoryClientSessionStorage) Delete(channelId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, channelId)
	return nil
}
