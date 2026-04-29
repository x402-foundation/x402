package server

import (
	"sync"

	"github.com/x402-foundation/x402/go/mechanisms/evm/batched"
)

// ChannelSession holds per-channel session state on the server side.
type ChannelSession struct {
	ChannelId               string                `json:"channelId"`
	ChannelConfig           batched.ChannelConfig `json:"channelConfig"`
	Payer                   string                `json:"payer"`
	ChargedCumulativeAmount string                `json:"chargedCumulativeAmount"`
	SignedMaxClaimable      string                `json:"signedMaxClaimable"`
	Signature               string                `json:"signature"`
	Balance                 string                `json:"balance"`
	TotalClaimed            string                `json:"totalClaimed"`
	WithdrawRequestedAt     int                   `json:"withdrawRequestedAt"`
	RefundNonce             int                   `json:"refundNonce"`
	LastRequestTimestamp    int64                 `json:"lastRequestTimestamp"`
}

// SessionStorage is the interface for persisting server-side channel sessions.
type SessionStorage interface {
	Get(channelId string) (*ChannelSession, error)
	Set(channelId string, session *ChannelSession) error
	Delete(channelId string) error
	List() ([]*ChannelSession, error)
	// CompareAndSet atomically updates a session only if the current
	// chargedCumulativeAmount matches expectedCharged. Returns true if the
	// swap succeeded, false if the value changed underneath (concurrent request).
	CompareAndSet(channelId string, expectedCharged string, session *ChannelSession) (bool, error)
}

// InMemoryChannelStorage is a volatile in-memory implementation of SessionStorage.
type InMemoryChannelStorage struct {
	mu       sync.RWMutex
	sessions map[string]*ChannelSession
}

// NewInMemoryChannelStorage creates a new in-memory server session storage.
func NewInMemoryChannelStorage() *InMemoryChannelStorage {
	return &InMemoryChannelStorage{
		sessions: make(map[string]*ChannelSession),
	}
}

func (s *InMemoryChannelStorage) Get(channelId string) (*ChannelSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	session, ok := s.sessions[channelId]
	if !ok {
		return nil, nil
	}
	copy := *session
	return &copy, nil
}

func (s *InMemoryChannelStorage) Set(channelId string, session *ChannelSession) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	copy := *session
	s.sessions[channelId] = &copy
	return nil
}

func (s *InMemoryChannelStorage) Delete(channelId string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.sessions, channelId)
	return nil
}

func (s *InMemoryChannelStorage) List() ([]*ChannelSession, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]*ChannelSession, 0, len(s.sessions))
	for _, session := range s.sessions {
		copy := *session
		result = append(result, &copy)
	}
	return result, nil
}

func (s *InMemoryChannelStorage) CompareAndSet(channelId string, expectedCharged string, session *ChannelSession) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	current, ok := s.sessions[channelId]
	if ok && current.ChargedCumulativeAmount != expectedCharged {
		return false, nil
	}
	copy := *session
	s.sessions[channelId] = &copy
	return true, nil
}
