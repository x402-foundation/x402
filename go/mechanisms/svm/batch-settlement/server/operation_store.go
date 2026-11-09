package server

import (
	"fmt"
	"sync"
)

// MemoryBatchOperationStore is the in-memory operation store used by the reference server.
type MemoryBatchOperationStore struct {
	mu         sync.Mutex
	operations map[string]BatchOperation
	locks      map[string]*sync.Mutex
}

// NewMemoryBatchOperationStore returns an empty operation store.
func NewMemoryBatchOperationStore() *MemoryBatchOperationStore {
	return &MemoryBatchOperationStore{
		operations: map[string]BatchOperation{},
		locks:      map[string]*sync.Mutex{},
	}
}

// Get returns a reserved or completed request operation.
func (s *MemoryBatchOperationStore) Get(channelID, requestID string) (*BatchOperation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	operation, ok := s.operations[operationKey(channelID, requestID)]
	if !ok {
		return nil, nil
	}
	return &operation, nil
}

// Reserve atomically creates a request reservation unless the operation already exists.
// An existing operation is returned unchanged, whatever its ceiling; the scheme rejects the reuse.
func (s *MemoryBatchOperationStore) Reserve(channelID, requestID string, ceiling uint64) (ReserveResult, error) {
	key := operationKey(channelID, requestID)
	lk := s.keyLock(key)
	lk.Lock()
	defer lk.Unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	if existing, ok := s.operations[key]; ok {
		return ReserveResult{Created: false, Operation: existing}, nil
	}
	operation := BatchOperation{
		Status:    operationReserved,
		ChannelID: channelID,
		RequestID: requestID,
		Ceiling:   ceiling,
	}
	s.operations[key] = operation
	return ReserveResult{Created: true, Operation: operation}, nil
}

// Complete atomically marks a reservation completed so the request cannot be reused.
func (s *MemoryBatchOperationStore) Complete(operation BatchOperation) error {
	key := operationKey(operation.ChannelID, operation.RequestID)
	lk := s.keyLock(key)
	lk.Lock()
	defer lk.Unlock()

	s.mu.Lock()
	defer s.mu.Unlock()
	existing, ok := s.operations[key]
	if !ok || existing.Status != operationReserved || existing.Ceiling != operation.Ceiling {
		return fmt.Errorf("batch operation reservation changed")
	}
	operation.Status = operationCompleted
	s.operations[key] = operation
	return nil
}

// Release ends failed or canceled work while retaining the consumed request id.
func (s *MemoryBatchOperationStore) Release(channelID, requestID string) error {
	key := operationKey(channelID, requestID)
	lk := s.keyLock(key)
	lk.Lock()
	defer lk.Unlock()
	// The capacity reservation is released by the channel store. This record
	// stays as a tombstone so a failed request cannot reuse its id.
	return nil
}

func (s *MemoryBatchOperationStore) keyLock(key string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	lk := s.locks[key]
	if lk == nil {
		lk = &sync.Mutex{}
		s.locks[key] = lk
	}
	return lk
}

func operationKey(channelID, requestID string) string {
	return channelID + "\x00" + requestID
}
