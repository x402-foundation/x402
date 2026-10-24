package facilitator

import (
	"context"
	"errors"
	"sync"
	"sync/atomic"
)

// Faults are consumed by sequential requests; the concurrent tests use the
// synchronized in-memory store directly.
type closeAccountingFaultStore struct {
	PendingSettlementStore
	marker   string
	failGet  bool
	failSet  bool
	writeKey string
}

func (s *closeAccountingFaultStore) Get(ctx context.Context, key string) (string, bool, error) {
	if key == s.marker && s.failGet {
		s.failGet = false
		return "", false, errors.New("accounting marker read failed")
	}
	return s.PendingSettlementStore.Get(ctx, key)
}

func (s *closeAccountingFaultStore) Set(ctx context.Context, key, value string) error {
	if key == s.writeKey {
		s.writeKey = ""
		return errors.New("attribution write failed")
	}
	if key == s.marker && s.failSet {
		s.failSet = false
		return errors.New("accounting marker write failed")
	}
	return s.PendingSettlementStore.Set(ctx, key, value)
}

// The cached-result path only reads Done when joining an existing accounting
// pass. Signal that wait so concurrency tests can release the owner deterministically.
type closeAccountingWaitContext struct {
	context.Context
	once    sync.Once
	waiting chan struct{}
}

func (c *closeAccountingWaitContext) Done() <-chan struct{} {
	c.once.Do(func() { close(c.waiting) })
	return c.Context.Done()
}

// Pause the first result read after capturing its value, without locking later
// reads. Another caller can finish accounting while this caller holds old data.
type closeResultReadBarrierStore struct {
	PendingSettlementStore
	key     string
	paused  atomic.Bool
	loaded  chan struct{}
	release chan struct{}
}

func (s *closeResultReadBarrierStore) Get(ctx context.Context, key string) (string, bool, error) {
	value, exists, err := s.PendingSettlementStore.Get(ctx, key)
	if key == s.key && s.paused.CompareAndSwap(false, true) {
		close(s.loaded)
		select {
		case <-s.release:
		case <-ctx.Done():
			return "", false, ctx.Err()
		}
	}
	return value, exists, err
}

// Gate a tagged caller's first write across either close-record key.
type closeInitialWriteBarrierStore struct {
	PendingSettlementStore
	key     string
	paused  atomic.Bool
	reached chan struct{}
	release chan struct{}
}

func (s *closeInitialWriteBarrierStore) Set(ctx context.Context, key, value string) error {
	if (key == s.key+":close" || key == s.key+":result") && ctx.Value(s) == true && s.paused.CompareAndSwap(false, true) {
		close(s.reached)
		select {
		case <-s.release:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	return s.PendingSettlementStore.Set(ctx, key, value)
}
