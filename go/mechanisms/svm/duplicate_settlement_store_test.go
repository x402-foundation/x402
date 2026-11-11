package svm

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInMemoryDuplicateSettlementStore(t *testing.T) {
	ctx := context.Background()

	t.Run("reserves a free key and reports the holder's signature to a second caller", func(t *testing.T) {
		store := NewInMemoryDuplicateSettlementStore()

		existing, reserved, err := store.Reserve(ctx, "op", "sig-1", time.Minute)
		require.NoError(t, err)
		assert.True(t, reserved)
		assert.Empty(t, existing)

		existing, reserved, err = store.Reserve(ctx, "op", "sig-2", time.Minute)
		require.NoError(t, err)
		assert.False(t, reserved)
		assert.Equal(t, "sig-1", existing)
	})

	t.Run("lets only one of many concurrent callers reserve a key", func(t *testing.T) {
		store := NewInMemoryDuplicateSettlementStore()
		var winners atomic.Int32
		var wg sync.WaitGroup
		for i := 0; i < 32; i++ {
			wg.Add(1)
			go func() {
				defer wg.Done()
				_, reserved, err := store.Reserve(ctx, "op", "sig", time.Minute)
				assert.NoError(t, err)
				if reserved {
					winners.Add(1)
				}
			}()
		}
		wg.Wait()
		assert.Equal(t, int32(1), winners.Load())
	})

	t.Run("frees a key once its ttl elapses", func(t *testing.T) {
		store := NewInMemoryDuplicateSettlementStore()
		clock := time.Unix(1_000, 0)
		store.now = func() time.Time { return clock }

		_, reserved, err := store.Reserve(ctx, "op", "sig-1", time.Minute)
		require.NoError(t, err)
		require.True(t, reserved)

		clock = clock.Add(time.Minute - time.Second)
		_, reserved, err = store.Reserve(ctx, "op", "sig-2", time.Minute)
		require.NoError(t, err)
		assert.False(t, reserved)

		clock = clock.Add(time.Second)
		_, reserved, err = store.Reserve(ctx, "op", "sig-2", time.Minute)
		require.NoError(t, err)
		assert.True(t, reserved)
	})

	t.Run("releases a key only for the signature that holds it", func(t *testing.T) {
		store := NewInMemoryDuplicateSettlementStore()
		_, reserved, err := store.Reserve(ctx, "op", "sig-1", time.Minute)
		require.NoError(t, err)
		require.True(t, reserved)

		require.NoError(t, store.Release(ctx, "op", "other"))
		existing, reserved, err := store.Reserve(ctx, "op", "sig-2", time.Minute)
		require.NoError(t, err)
		assert.False(t, reserved)
		assert.Equal(t, "sig-1", existing)

		require.NoError(t, store.Release(ctx, "op", "sig-1"))
		_, reserved, err = store.Reserve(ctx, "op", "sig-2", time.Minute)
		require.NoError(t, err)
		assert.True(t, reserved)
	})

	t.Run("treats a release of an absent key as a no-op", func(t *testing.T) {
		require.NoError(t, NewInMemoryDuplicateSettlementStore().Release(ctx, "missing", "sig"))
	})
}
