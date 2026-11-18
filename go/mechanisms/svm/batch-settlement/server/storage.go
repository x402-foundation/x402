package server

import "sync"

// MemoryChannelStore is an in-memory ChannelStore that serializes updates per channel.
// List returns channels in insertion order.
type MemoryChannelStore struct {
	mu       sync.Mutex
	order    []string
	channels map[string]ChannelState
	locks    map[string]*sync.Mutex
}

// NewMemoryChannelStore returns an empty in-memory channel store.
func NewMemoryChannelStore() *MemoryChannelStore {
	return &MemoryChannelStore{
		channels: map[string]ChannelState{},
		locks:    map[string]*sync.Mutex{},
	}
}

// List returns every channel this store holds, in insertion order.
func (s *MemoryChannelStore) List() ([]ChannelState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := make([]ChannelState, 0, len(s.order))
	for _, id := range s.order {
		out = append(out, cloneState(s.channels[id]))
	}
	return out, nil
}

// Get returns a channel's state, or nil when the channel is unknown.
func (s *MemoryChannelStore) Get(channelID string) (*ChannelState, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	state, ok := s.channels[channelID]
	if !ok {
		return nil, nil
	}
	cloned := cloneState(state)
	return &cloned, nil
}

// Put inserts or overwrites a channel's state.
func (s *MemoryChannelStore) Put(state ChannelState) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.storeLocked(state.ChannelID, state)
	return nil
}

// Update atomically read-modify-writes one channel. Concurrent updates to the same channel queue.
func (s *MemoryChannelStore) Update(
	channelID string,
	updater func(current *ChannelState) (ChannelState, error),
) (ChannelState, error) {
	lk := s.channelLock(channelID)
	lk.Lock()
	defer lk.Unlock()

	s.mu.Lock()
	current, ok := s.channels[channelID]
	s.mu.Unlock()

	var currentPtr *ChannelState
	if ok {
		cloned := cloneState(current)
		currentPtr = &cloned
	}
	next, err := updater(currentPtr)
	if err != nil {
		return ChannelState{}, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.storeLocked(channelID, next)
	return cloneState(s.channels[channelID]), nil
}

func (s *MemoryChannelStore) storeLocked(channelID string, state ChannelState) {
	if _, exists := s.channels[channelID]; !exists {
		s.order = append(s.order, channelID)
	}
	s.channels[channelID] = cloneState(state)
}

func (s *MemoryChannelStore) channelLock(channelID string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	lk := s.locks[channelID]
	if lk == nil {
		lk = &sync.Mutex{}
		s.locks[channelID] = lk
	}
	return lk
}

func cloneState(state ChannelState) ChannelState {
	if state.Reservations == nil {
		return state
	}
	cloned := state
	cloned.Reservations = make(map[string]ChannelReservation, len(state.Reservations))
	for id, reservation := range state.Reservations {
		cloned.Reservations[id] = reservation
	}
	return cloned
}
