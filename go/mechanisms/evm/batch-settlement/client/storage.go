package client

import (
	"sync"

	batchsettlement "github.com/x402-foundation/x402/go/v2/mechanisms/evm/batch-settlement"
)

// BatchSettlementClientContext holds per-channel session state on the client side.
type BatchSettlementClientContext struct {
	ChargedCumulativeAmount string `json:"chargedCumulativeAmount"`
	Balance                 string `json:"balance"`
	TotalClaimed            string `json:"totalClaimed"`
	DepositAmount           string `json:"depositAmount,omitempty"`
	SignedMaxClaimable      string `json:"signedMaxClaimable,omitempty"`
	Signature               string `json:"signature,omitempty"`
}

// ClientChannelStorage is the interface for persisting client-side channel sessions.
type ClientChannelStorage interface {
	Get(channelId string) (*BatchSettlementClientContext, error)
	Set(channelId string, ctx *BatchSettlementClientContext) error
	Delete(channelId string) error
}

// InMemoryClientChannelStorage is a volatile in-memory implementation of ClientChannelStorage.
type InMemoryClientChannelStorage struct {
	mu       sync.RWMutex
	sessions map[string]*BatchSettlementClientContext
}

// NewInMemoryClientChannelStorage creates a new in-memory client session storage.
func NewInMemoryClientChannelStorage() *InMemoryClientChannelStorage {
	return &InMemoryClientChannelStorage{
		sessions: make(map[string]*BatchSettlementClientContext),
	}
}

func (s *InMemoryClientChannelStorage) Get(channelId string) (*BatchSettlementClientContext, error) {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return nil, err
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	ctx, ok := s.sessions[key]
	if !ok {
		return nil, nil
	}
	// Return a copy
	copy := *ctx
	return &copy, nil
}

func (s *InMemoryClientChannelStorage) Set(channelId string, ctx *BatchSettlementClientContext) error {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := *ctx
	s.sessions[key] = &copy
	return nil
}

func (s *InMemoryClientChannelStorage) Delete(channelId string) error {
	key, err := batchsettlement.NormalizeChannelId(channelId)
	if err != nil {
		return err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, key)
	return nil
}
