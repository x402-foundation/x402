package x402

import (
	"context"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInMemoryPendingSettlementStore_GetMiss(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()

	txHash, ok, err := store.Get(context.Background(), "missing-key")
	require.NoError(t, err)
	assert.False(t, ok)
	assert.Empty(t, txHash)
}

func TestInMemoryPendingSettlementStore_SetThenGetReturnsStoredValue(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()

	require.NoError(t, store.Set(context.Background(), "key-1", "0xabc"))

	txHash, ok, err := store.Get(context.Background(), "key-1")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "0xabc", txHash)
}

func TestInMemoryPendingSettlementStore_SetOverwritesPriorValueForSameKey(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()

	require.NoError(t, store.Set(context.Background(), "key-1", "0xabc"))
	require.NoError(t, store.Set(context.Background(), "key-1", "0xdef"))

	txHash, ok, err := store.Get(context.Background(), "key-1")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "0xdef", txHash)
}

func TestInMemoryPendingSettlementStore_DeleteRemovesEntry(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()
	require.NoError(t, store.Set(context.Background(), "key-1", "0xabc"))

	require.NoError(t, store.Delete(context.Background(), "key-1"))

	_, ok, err := store.Get(context.Background(), "key-1")
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestInMemoryPendingSettlementStore_DeleteOnMissingKeyIsANoOp(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()

	assert.NoError(t, store.Delete(context.Background(), "never-existed"))

	_, ok, err := store.Get(context.Background(), "never-existed")
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestInMemoryPendingSettlementStore_DistinctKeysDoNotCollide(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()

	require.NoError(t, store.Set(context.Background(), "key-a", "0xaaa"))
	require.NoError(t, store.Set(context.Background(), "key-b", "0xbbb"))

	txA, okA, _ := store.Get(context.Background(), "key-a")
	txB, okB, _ := store.Get(context.Background(), "key-b")
	assert.True(t, okA)
	assert.Equal(t, "0xaaa", txA)
	assert.True(t, okB)
	assert.Equal(t, "0xbbb", txB)

	require.NoError(t, store.Delete(context.Background(), "key-a"))
	_, okA, _ = store.Get(context.Background(), "key-a")
	assert.False(t, okA)
	txB, okB, _ = store.Get(context.Background(), "key-b")
	assert.True(t, okB)
	assert.Equal(t, "0xbbb", txB)
}

// backdate rewrites key's storedAt timestamp directly (bypassing Set, which
// always stamps "now") so tests can simulate an entry that is already older
// than PendingSettlementTTL without sleeping.
func backdate(store *InMemoryPendingSettlementStore, key string, age time.Duration) {
	store.mu.Lock()
	defer store.mu.Unlock()
	entry, ok := store.entries[key]
	if !ok {
		return
	}
	entry.storedAt = time.Now().Add(-age)
	store.entries[key] = entry
}

func TestInMemoryPendingSettlementStore_EntriesOlderThanTTLArePrunedOnGet(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()
	require.NoError(t, store.Set(context.Background(), "expired", "0xabc"))
	backdate(store, "expired", PendingSettlementTTL+time.Second)

	_, ok, err := store.Get(context.Background(), "expired")
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestInMemoryPendingSettlementStore_FreshEntriesSurvivePruning(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()
	require.NoError(t, store.Set(context.Background(), "expired", "0xabc"))
	require.NoError(t, store.Set(context.Background(), "fresh", "0xdef"))
	backdate(store, "expired", PendingSettlementTTL+time.Second)

	// Triggers a prune pass as a side effect of Get().
	_, expiredOk, _ := store.Get(context.Background(), "expired")
	freshTx, freshOk, _ := store.Get(context.Background(), "fresh")

	assert.False(t, expiredOk)
	assert.True(t, freshOk)
	assert.Equal(t, "0xdef", freshTx)
}

func TestInMemoryPendingSettlementStore_KeepsAnEntryThatHasNotYetReachedTheTTL(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()
	require.NoError(t, store.Set(context.Background(), "key-1", "0xabc"))
	backdate(store, "key-1", PendingSettlementTTL-time.Second)

	txHash, ok, err := store.Get(context.Background(), "key-1")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "0xabc", txHash)
}

func TestInMemoryPendingSettlementStore_SetRefreshesAnExistingKeysTimestamp(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()
	require.NoError(t, store.Set(context.Background(), "key-1", "0xabc"))
	backdate(store, "key-1", PendingSettlementTTL-time.Second)

	// Refresh: a subsequent Set must reset storedAt to now.
	require.NoError(t, store.Set(context.Background(), "key-1", "0xdef"))
	backdate(store, "key-1", PendingSettlementTTL-time.Second)

	txHash, ok, err := store.Get(context.Background(), "key-1")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "0xdef", txHash)
}

func TestInMemoryPendingSettlementStore_EntriesReturnsATxHashOnlySnapshot(t *testing.T) {
	store := NewInMemoryPendingSettlementStore()
	require.NoError(t, store.Set(context.Background(), "key-a", "0xaaa"))
	require.NoError(t, store.Set(context.Background(), "key-b", "0xbbb"))

	snapshot := store.Entries()

	assert.Equal(t, map[string]string{"key-a": "0xaaa", "key-b": "0xbbb"}, snapshot)
}

// recordingPendingSettlementStore proves mechanism code depending on
// PendingSettlementStore only needs the interface, never the concrete
// InMemoryPendingSettlementStore type. Mirrors the TS/Python test doubles of
// the same name.
type recordingPendingSettlementStore struct {
	getCalls    []string
	setCalls    []string
	deleteCalls []string
	entries     map[string]string
}

func newRecordingPendingSettlementStore() *recordingPendingSettlementStore {
	return &recordingPendingSettlementStore{entries: make(map[string]string)}
}

func (s *recordingPendingSettlementStore) Get(_ context.Context, key string) (string, bool, error) {
	s.getCalls = append(s.getCalls, key)
	txHash, ok := s.entries[key]
	return txHash, ok, nil
}

func (s *recordingPendingSettlementStore) Set(_ context.Context, key string, txHash string) error {
	s.setCalls = append(s.setCalls, key)
	s.entries[key] = txHash
	return nil
}

func (s *recordingPendingSettlementStore) Delete(_ context.Context, key string) error {
	s.deleteCalls = append(s.deleteCalls, key)
	delete(s.entries, key)
	return nil
}

func TestPendingSettlementStoreInterface_CustomImplementationBehavesLikeDefault(t *testing.T) {
	var store PendingSettlementStore = newRecordingPendingSettlementStore()

	_, ok, err := store.Get(context.Background(), "k")
	require.NoError(t, err)
	assert.False(t, ok)

	require.NoError(t, store.Set(context.Background(), "k", "0x1"))
	txHash, ok, err := store.Get(context.Background(), "k")
	require.NoError(t, err)
	assert.True(t, ok)
	assert.Equal(t, "0x1", txHash)

	require.NoError(t, store.Delete(context.Background(), "k"))
	_, ok, err = store.Get(context.Background(), "k")
	require.NoError(t, err)
	assert.False(t, ok)
}

func TestPendingSettlementStoreInterface_RecordsInteractionsDistinctlyFromTheInMemoryImplementation(t *testing.T) {
	store := newRecordingPendingSettlementStore()

	require.NoError(t, store.Set(context.Background(), "k", "0x1"))
	_, _, _ = store.Get(context.Background(), "k")
	require.NoError(t, store.Delete(context.Background(), "k"))

	assert.Equal(t, []string{"k"}, store.setCalls)
	assert.Equal(t, []string{"k"}, store.getCalls)
	assert.Equal(t, []string{"k"}, store.deleteCalls)
}
