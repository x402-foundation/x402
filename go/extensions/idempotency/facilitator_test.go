package idempotency

import (
	"context"
	"sync"
	"testing"
	"time"

	x402 "github.com/coinbase/x402/go"
)

// mockStore implements SettlementStore for testing
type mockStore struct {
	mu           sync.Mutex
	checkCalls   int
	completeCalls int
	failCalls    int
	status       SettlementStatus
	cachedResult *x402.SettleResponse
	done         chan struct{}
}

func newMockStore(status SettlementStatus, cachedResult *x402.SettleResponse) *mockStore {
	return &mockStore{
		status:       status,
		cachedResult: cachedResult,
		done:         make(chan struct{}),
	}
}

func (m *mockStore) CheckAndMark(key string) (SettlementStatus, *x402.SettleResponse, chan struct{}) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.checkCalls++
	return m.status, m.cachedResult, m.done
}

func (m *mockStore) WaitForResult(ctx context.Context, key string, done chan struct{}) (*x402.SettleResponse, error) {
	select {
	case <-done:
		m.mu.Lock()
		defer m.mu.Unlock()
		return m.cachedResult, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

func (m *mockStore) Complete(key string, response *x402.SettleResponse, done chan struct{}) {
	m.mu.Lock()
	m.completeCalls++
	m.cachedResult = response
	m.mu.Unlock()
	close(done)
}

func (m *mockStore) Fail(key string, done chan struct{}) {
	m.mu.Lock()
	m.failCalls++
	m.mu.Unlock()
	close(done)
}

func TestWrap_DefaultOptions(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	wrapped := Wrap(baseFacilitator)

	if wrapped == nil {
		t.Fatal("Expected non-nil IdempotentFacilitator")
	}
	if wrapped.inner != baseFacilitator {
		t.Error("Expected inner to be the base facilitator")
	}
	if wrapped.store == nil {
		t.Error("Expected store to be initialized")
	}
	if wrapped.keyGenerator == nil {
		t.Error("Expected keyGenerator to be initialized")
	}
}

func TestWrap_WithCustomTTL(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	wrapped := Wrap(baseFacilitator, WithTTL(30*time.Minute))

	if wrapped == nil {
		t.Fatal("Expected non-nil IdempotentFacilitator")
	}

	// Verify store was created with correct TTL by checking type
	store, ok := wrapped.store.(*InMemoryStore)
	if !ok {
		t.Fatal("Expected InMemoryStore")
	}
	if store.ttl != 30*time.Minute {
		t.Errorf("Expected TTL 30m, got %v", store.ttl)
	}
}

func TestWrap_WithCustomStore(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	customStore := newMockStore(StatusNotFound, nil)
	wrapped := Wrap(baseFacilitator, WithStore(customStore))

	if wrapped.store != customStore {
		t.Error("Expected custom store to be used")
	}
}

func TestWrap_WithCustomKeyGenerator(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	customGenerator := func(payload []byte) string {
		return "custom-key"
	}
	wrapped := Wrap(baseFacilitator, WithKeyGenerator(customGenerator))

	// Test that custom generator is used
	key := wrapped.keyGenerator([]byte("test"))
	if key != "custom-key" {
		t.Errorf("Expected custom-key, got %s", key)
	}
}

func TestIdempotentFacilitator_Settle_CachedResult(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	cachedResponse := &x402.SettleResponse{
		Success:     true,
		Transaction: "0xcached",
		Payer:       "0xpayer",
		Network:     "eip155:1",
	}
	mockStore := newMockStore(StatusCached, cachedResponse)

	wrapped := Wrap(baseFacilitator, WithStore(mockStore))

	ctx := context.Background()
	result, err := wrapped.Settle(ctx, []byte(`{}`), []byte(`{}`))

	if err != nil {
		t.Fatalf("Expected no error, got %v", err)
	}
	if result == nil {
		t.Fatal("Expected non-nil result")
	}
	if result.Transaction != "0xcached" {
		t.Errorf("Expected cached transaction, got %s", result.Transaction)
	}

	// Verify store was checked but not completed (since we returned cached)
	if mockStore.checkCalls != 1 {
		t.Errorf("Expected 1 check call, got %d", mockStore.checkCalls)
	}
	if mockStore.completeCalls != 0 {
		t.Errorf("Expected 0 complete calls (cached hit), got %d", mockStore.completeCalls)
	}
}

func TestIdempotentFacilitator_Inner(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	wrapped := Wrap(baseFacilitator)

	inner := wrapped.Inner()
	if inner != baseFacilitator {
		t.Error("Expected Inner() to return base facilitator")
	}
}

func TestIdempotentFacilitator_GetSupported(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	wrapped := Wrap(baseFacilitator)

	// GetSupported should delegate to inner facilitator
	supported := wrapped.GetSupported()

	// Empty facilitator should return empty kinds
	if len(supported.Kinds) != 0 {
		t.Errorf("Expected empty kinds, got %d", len(supported.Kinds))
	}
}

func TestIdempotentFacilitator_RegisterChaining(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	wrapped := Wrap(baseFacilitator)

	// Test that Register returns self for chaining
	result := wrapped.RegisterExtension("test-extension")
	if result != wrapped {
		t.Error("Expected Register to return self for chaining")
	}
}

func TestIdempotentFacilitator_HookRegistration(t *testing.T) {
	baseFacilitator := x402.Newx402Facilitator()
	wrapped := Wrap(baseFacilitator)

	hook := func(ctx x402.FacilitatorSettleResultContext) error {
		// Hook would be called during actual settlement
		return nil
	}

	// Register hook through wrapper
	result := wrapped.OnAfterSettle(hook)
	if result != wrapped {
		t.Error("Expected OnAfterSettle to return self for chaining")
	}

	// Hook should be registered on inner facilitator
	// We can't easily verify this without calling Settle, but at least
	// we verify no panic occurs
}
