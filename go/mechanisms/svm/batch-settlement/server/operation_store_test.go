package server_test

import (
	"sort"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/x402-foundation/x402/go/v2/mechanisms/svm/batch-settlement/server"
)

func TestMemoryBatchOperationStore(t *testing.T) {
	t.Run("atomically reserves one operation per request id", func(t *testing.T) {
		store := server.NewMemoryBatchOperationStore()
		var first, second server.ReserveResult
		var firstErr, secondErr error
		var wg sync.WaitGroup
		wg.Add(2)
		go func() {
			defer wg.Done()
			first, firstErr = store.Reserve("channel", "request", 1000)
		}()
		go func() {
			defer wg.Done()
			second, secondErr = store.Reserve("channel", "request", 1000)
		}()
		wg.Wait()
		require.NoError(t, firstErr)
		require.NoError(t, secondErr)
		created := []bool{first.Created, second.Created}
		sort.Slice(created, func(i, j int) bool { return !created[i] && created[j] })
		assert.Equal(t, []bool{false, true}, created)

		_, err := store.Reserve("channel", "request", 999)
		require.Error(t, err)
		assert.Contains(t, err.Error(), "ceiling changed")
	})

	t.Run("permanently rejects failed and completed request ids", func(t *testing.T) {
		store := server.NewMemoryBatchOperationStore()
		_, err := store.Reserve("channel", "request", 1000)
		require.NoError(t, err)
		require.NoError(t, store.Release("channel", "request"))
		replay, err := store.Reserve("channel", "request", 1000)
		require.NoError(t, err)
		assert.False(t, replay.Created)

		completedStore := server.NewMemoryBatchOperationStore()
		_, err = completedStore.Reserve("channel", "request", 1000)
		require.NoError(t, err)
		require.NoError(t, completedStore.Complete(server.BatchOperation{
			Actual:     500,
			Ceiling:    1000,
			ChannelID:  "channel",
			Cumulative: 500,
			RequestID:  "request",
			Status:     "completed",
		}))
		replay, err = completedStore.Reserve("channel", "request", 1000)
		require.NoError(t, err)
		assert.False(t, replay.Created)
		assert.Equal(t, "completed", replay.Operation.Status)
		require.NoError(t, completedStore.Release("channel", "request"))
		stored, err := completedStore.Get("channel", "request")
		require.NoError(t, err)
		require.NotNil(t, stored)
		assert.Equal(t, "completed", stored.Status)
	})
}
