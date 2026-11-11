package facilitator

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	x402 "github.com/x402-foundation/x402/go/v2"
)

func TestRetainedPendingStore(t *testing.T) {
	ctx := context.Background()
	clock := time.Unix(1_000_000, 0)
	store := newRetainedPendingStore()
	store.now = func() time.Time { return clock }

	require.NoError(t, store.Set(ctx, resultKey("batch:seal:k"), `{"success":true}`))

	clock = clock.Add(x402.PendingSettlementTTL + time.Minute)
	got, ok, err := store.Get(ctx, resultKey("batch:seal:k"))
	require.NoError(t, err)
	assert.True(t, ok, "a payout must outlive the shared store's five-minute TTL so a failing hook can be retried")
	assert.JSONEq(t, `{"success":true}`, got)

	clock = clock.Add(PendingRetention)
	_, ok, err = store.Get(ctx, resultKey("batch:seal:k"))
	require.NoError(t, err)
	assert.False(t, ok, "entries are still bounded")

	require.NoError(t, store.Set(ctx, "pending", "sig"))
	require.NoError(t, store.Delete(ctx, "pending"))
	_, ok, err = store.Get(ctx, "pending")
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestNewBatchSvmSchemeDefaultsToTheRetainedPendingStore(t *testing.T) {
	scheme := NewBatchSvmScheme(context.Background(), newScriptedSigner(t, 1), &Config{})
	assert.IsType(t, &retainedPendingStore{}, scheme.pendingStore)
}
