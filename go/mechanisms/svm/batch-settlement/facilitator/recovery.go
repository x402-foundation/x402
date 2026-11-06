package facilitator

import (
	"context"
	"sync"

	solana "github.com/gagliardetto/solana-go"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
)

// PendingSettlementStore records pending signatures and completed operation outcomes.
// Records outlive an unresolved transaction: this store does not evict them.
type PendingSettlementStore interface {
	Get(ctx context.Context, key string) (string, bool, error)
	Set(ctx context.Context, key, value string) error
	Delete(ctx context.Context, key string) error
}

// ConditionalPendingStore adds atomic reservation for multi-process recovery.
type ConditionalPendingStore interface {
	PendingSettlementStore
	// SetIfAbsent inserts key only when it is absent. False means another worker owns it.
	SetIfAbsent(ctx context.Context, key, value string) (bool, error)
	// DeleteIfEquals removes key only when it still holds value.
	DeleteIfEquals(ctx context.Context, key, value string) (bool, error)
}

// InMemoryPendingSettlementStore is process-local recovery with no eviction of unresolved work.
type InMemoryPendingSettlementStore struct {
	mu      sync.Mutex
	records map[string]string
}

// NewInMemoryPendingSettlementStore creates an empty in-memory recovery store.
func NewInMemoryPendingSettlementStore() *InMemoryPendingSettlementStore {
	return &InMemoryPendingSettlementStore{records: make(map[string]string)}
}

// Get returns a stored value. A missing key returns ("", false, nil).
func (s *InMemoryPendingSettlementStore) Get(_ context.Context, key string) (string, bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, ok := s.records[key]
	return value, ok, nil
}

// Set records key's value, overwriting any previous one.
func (s *InMemoryPendingSettlementStore) Set(_ context.Context, key, value string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records[key] = value
	return nil
}

// SetIfAbsent inserts key when it is absent.
func (s *InMemoryPendingSettlementStore) SetIfAbsent(_ context.Context, key, value string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, ok := s.records[key]; ok {
		return false, nil
	}
	s.records[key] = value
	return true, nil
}

// DeleteIfEquals removes key only when it still holds value.
func (s *InMemoryPendingSettlementStore) DeleteIfEquals(_ context.Context, key, value string) (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.records[key] != value {
		return false, nil
	}
	delete(s.records, key)
	return true, nil
}

// Delete removes key.
func (s *InMemoryPendingSettlementStore) Delete(_ context.Context, key string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.records, key)
	return nil
}

type reservationChain struct {
	mu      sync.Mutex
	pending map[pendingKey]chan struct{}
}

type pendingKey struct {
	store PendingSettlementStore
	key   string
}

var legacyReservations = &reservationChain{pending: map[pendingKey]chan struct{}{}}

// ReserveBroadcast reserves key for signature. Stores with SetIfAbsent use that.
// Other stores are serialized in this process.
func ReserveBroadcast(ctx context.Context, store PendingSettlementStore, key, signature string) (bool, error) {
	if conditional, ok := store.(ConditionalPendingStore); ok {
		return conditional.SetIfAbsent(ctx, key, signature)
	}
	legacyReservations.mu.Lock()
	token := pendingKey{store: store, key: key}
	for {
		wait, busy := legacyReservations.pending[token]
		if !busy {
			legacyReservations.pending[token] = make(chan struct{})
			legacyReservations.mu.Unlock()
			break
		}
		legacyReservations.mu.Unlock()
		select {
		case <-ctx.Done():
			return false, ctx.Err()
		case <-wait:
		}
		legacyReservations.mu.Lock()
	}
	defer func() {
		legacyReservations.mu.Lock()
		close(legacyReservations.pending[token])
		delete(legacyReservations.pending, token)
		legacyReservations.mu.Unlock()
	}()
	existing, ok, err := store.Get(ctx, key)
	if err != nil {
		return false, err
	}
	if ok && existing != "" {
		return false, nil
	}
	if err := store.Set(ctx, key, signature); err != nil {
		return false, err
	}
	return true, nil
}

// BroadcastExpiredWithoutLanding reports whether a broadcast whose confirmation
// was never observed can no longer land. Anything uncertain answers false.
func BroadcastExpiredWithoutLanding(
	ctx context.Context,
	signer svm.FacilitatorSvmSigner,
	signature solana.Signature,
	network, wire string,
) bool {
	if wire == "" {
		return false
	}
	blockhash, ok := signer.(svm.FacilitatorBlockhashCapabilities)
	history, historyOK := signer.(svm.FacilitatorConfirmedTransactionReader)
	if !ok || !historyOK {
		return false
	}
	tx, err := svm.DecodeTransaction(wire)
	if err != nil {
		return false
	}
	valid, err := blockhash.IsBlockhashValid(ctx, tx.Message.RecentBlockhash, network)
	if err != nil || valid {
		return false
	}
	confirmed, err := history.GetConfirmedTransaction(ctx, signature, network)
	if err != nil {
		return false
	}
	return confirmed == nil
}

// DiscardWire drops the signed bytes kept for rebroadcast. A store error is ignored.
func DiscardWire(ctx context.Context, store PendingSettlementStore, network, signature string) {
	_ = store.Delete(ctx, "batch:transaction:"+network+":"+signature+":wire")
}

// PayoutAttributionAmbiguousError means a confirmed sweep cannot be attributed
// because the merchant recipient is also the refund or treasury beneficiary.
type PayoutAttributionAmbiguousError struct{}

func (e *PayoutAttributionAmbiguousError) Error() string {
	return "closed-channel payout shares its recipient with refund or treasury; transfer attribution is ambiguous"
}
