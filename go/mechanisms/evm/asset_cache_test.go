package evm

import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const cacheTestAsset = "0x00000000000000000000000000000000000000bb"

// countingCodeSigner reports the asset as deployed and counts eth_getCode calls.
type countingCodeSigner struct {
	mockStrictSigner
	calls int
}

func (s *countingCodeSigner) GetCode(_ context.Context, _ string) ([]byte, error) {
	s.calls++
	return []byte{0x60, 0x60}, nil
}

func TestAssetContractCheckCachesPositiveResult(t *testing.T) {
	ResetAssetContractCache()

	signer := &countingCodeSigner{}
	for range 3 {
		reason, err := StartAssetContractCheck(context.Background(), signer, "eip155:84532", cacheTestAsset).Await()
		require.NoError(t, err)
		assert.Empty(t, reason)
	}

	assert.Equal(t, 1, signer.calls, "only the first check should reach the RPC")
}

// A caller that never awaits must leave the cache untouched, so cache contents do not depend on
// goroutine scheduling.
func TestAssetContractCheckWithoutAwaitDoesNotCache(t *testing.T) {
	ResetAssetContractCache()

	signer := &countingCodeSigner{}
	abandoned := StartAssetContractCheck(context.Background(), signer, "eip155:84532", cacheTestAsset)
	<-abandoned.results

	reason, err := StartAssetContractCheck(context.Background(), signer, "eip155:84532", cacheTestAsset).Await()
	require.NoError(t, err)
	assert.Empty(t, reason)
	assert.Equal(t, 2, signer.calls, "the abandoned check must not have populated the cache")
}

// An empty network cannot be cached: entries would otherwise collide across chains, where one
// address can hold bytecode on one chain and nothing on another.
func TestAssetContractCacheSkipsEmptyNetwork(t *testing.T) {
	ResetAssetContractCache()

	signer := &countingCodeSigner{}
	for range 2 {
		_, err := StartAssetContractCheck(context.Background(), signer, "", cacheTestAsset).Await()
		require.NoError(t, err)
	}

	assert.Equal(t, 2, signer.calls, "an empty network must bypass the cache")
	assert.False(t, globalAssetContractCache.isFresh(assetContractCacheKey{asset: cacheTestAsset}, time.Now()))
}

func TestAssetContractCacheEntriesExpire(t *testing.T) {
	ResetAssetContractCache()

	key := assetContractCacheKey{network: "eip155:84532", asset: cacheTestAsset}
	start := time.Now()
	globalAssetContractCache.record(key, start)

	assert.True(t, globalAssetContractCache.isFresh(key, start.Add(DefaultAssetContractCacheTTL-time.Second)))
	assert.False(t, globalAssetContractCache.isFresh(key, start.Add(DefaultAssetContractCacheTTL+time.Second)))
}

// The cache is keyed partly by caller-supplied asset addresses, so it must not grow without
// bound when many distinct deployed contracts are named within one TTL window.
func TestAssetContractCacheIsBounded(t *testing.T) {
	ResetAssetContractCache()

	now := time.Now()
	for i := range maxAssetContractCacheEntries + 500 {
		globalAssetContractCache.record(
			assetContractCacheKey{network: "eip155:84532", asset: fmt.Sprintf("0x%040x", i)},
			now,
		)
	}

	globalAssetContractCache.mu.RLock()
	size := len(globalAssetContractCache.expiries)
	globalAssetContractCache.mu.RUnlock()

	assert.LessOrEqual(t, size, maxAssetContractCacheEntries)
}
