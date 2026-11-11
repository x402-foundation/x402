package facilitator

import (
	"context"
	"sync"
	"testing"

	solana "github.com/gagliardetto/solana-go"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm"
	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/paymentchannels"
)

// strictContextStore fails calls on a done context, like Redis, and counts reads per key.
type strictContextStore struct {
	inner *x402.InMemoryPendingSettlementStore
	mu    sync.Mutex
	gets  map[string]int
}

func newStrictContextStore() *strictContextStore {
	return &strictContextStore{inner: x402.NewInMemoryPendingSettlementStore(), gets: map[string]int{}}
}

func (s *strictContextStore) Get(ctx context.Context, key string) (string, bool, error) {
	if err := ctx.Err(); err != nil {
		return "", false, err
	}
	s.mu.Lock()
	s.gets[key]++
	s.mu.Unlock()
	return s.inner.Get(ctx, key)
}

func (s *strictContextStore) Set(ctx context.Context, key, value string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.inner.Set(ctx, key, value)
}

func (s *strictContextStore) Delete(ctx context.Context, key string) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.inner.Delete(ctx, key)
}

func (s *strictContextStore) readCount(key string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.gets[key]
}

func TestBatchSettlementRecoveryOutlivesRequestContext(t *testing.T) {
	network := string(svm.SolanaDevnetCAIP2)
	const key = "batch:deposit:test"
	payer := mustKey(t).PublicKey().String()
	signature := solana.Signature{2}.String()

	newScheme := func(t *testing.T, store x402.PendingSettlementStore) *BatchSvmScheme {
		t.Helper()
		signer := &confirmingSigner{scriptedSigner: newScriptedSigner(t, 1), slot: 1}
		return NewBatchSvmScheme(context.Background(), signer, &Config{PendingSettlementStore: store})
	}

	t.Run("a confirmation timeout on a cancelled context is recorded as pending", func(t *testing.T) {
		store := newStrictContextStore()
		scheme := newScheme(t, store)
		ctx, cancel := context.WithCancel(context.Background())
		defer cancel()

		result, err := scheme.broadcastDurably(ctx, key, network, payer, func(func(string, string) error) (string, error) {
			cancel()
			return "", &paymentchannels.SettlementConfirmationTimeoutError{Signature: signature}
		})

		require.NoError(t, err, "the expired request context must not fail the recovery read")
		require.NotNil(t, result.Response)
		assert.Equal(t, x402.ErrSettlementPending, result.Response.ErrorReason)
		assert.Equal(t, signature, result.Response.Transaction)
		recorded, ok, err := store.inner.Get(context.Background(), key)
		require.NoError(t, err)
		assert.True(t, ok)
		assert.Equal(t, signature, recorded)
	})

	t.Run("a durable settle reads the pending key once", func(t *testing.T) {
		store := newStrictContextStore()
		scheme := newScheme(t, store)

		_, got, response, err := scheme.settleDurably(context.Background(), durableArgs{
			key:     key,
			network: network,
			payer:   payer,
			send: func(func(string, string) error) (string, error) {
				return signature, nil
			},
			postcondition: func(string, durablePhase) (any, *x402.SettleResponse, error) {
				return nil, nil, nil
			},
		})

		require.NoError(t, err)
		assert.Nil(t, response)
		assert.Equal(t, signature, got)
		assert.Equal(t, 1, store.readCount(key))
	})
}
