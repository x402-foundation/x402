package evm

import (
	"context"
	"sync"
	"time"
)

// DefaultAssetContractCacheTTL bounds how long a positive asset-contract check is reused.
const DefaultAssetContractCacheTTL = 15 * time.Minute

// maxAssetContractCacheEntries bounds the cache so callers naming many distinct deployed
// contracts cannot grow it without limit. A facilitator serves few assets per chain.
const maxAssetContractCacheEntries = 4096

// assetContractCache memoizes "this asset address has bytecode" per network. It is process-wide
// because ValidateAssetIsContract is a free function shared by every EVM facilitator scheme.
//
// Only positive results are stored: a negative result may be a token observed mid-deployment,
// which has to self-heal on the next request.
type assetContractCache struct {
	mu       sync.RWMutex
	ttl      time.Duration
	expiries map[assetContractCacheKey]time.Time
}

type assetContractCacheKey struct {
	network string
	asset   string
}

var globalAssetContractCache = &assetContractCache{
	ttl:      DefaultAssetContractCacheTTL,
	expiries: make(map[assetContractCacheKey]time.Time),
}

// isFresh reports whether an unexpired positive result is cached. An empty network is never
// cached, since entries would otherwise collide across chains where one address can hold
// bytecode on one chain and nothing on another.
func (c *assetContractCache) isFresh(key assetContractCacheKey, now time.Time) bool {
	if key.network == "" {
		return false
	}

	c.mu.RLock()
	defer c.mu.RUnlock()

	expiry, ok := c.expiries[key]
	return ok && now.Before(expiry)
}

func (c *assetContractCache) record(key assetContractCacheKey, now time.Time) {
	if key.network == "" {
		return
	}

	c.mu.Lock()
	defer c.mu.Unlock()

	for existing, expiry := range c.expiries {
		if now.After(expiry) {
			delete(c.expiries, existing)
		}
	}
	if _, ok := c.expiries[key]; !ok && len(c.expiries) >= maxAssetContractCacheEntries {
		return
	}
	c.expiries[key] = now.Add(c.ttl)
}

// ResetAssetContractCache clears the process-wide asset-contract cache, for tests that assert
// on eth_getCode call counts across cases sharing an asset address.
func ResetAssetContractCache() {
	globalAssetContractCache.mu.Lock()
	defer globalAssetContractCache.mu.Unlock()

	globalAssetContractCache.expiries = make(map[assetContractCacheKey]time.Time)
}

// AssetContractCheck is an asset-contract check running in the background.
type AssetContractCheck struct {
	network string
	asset   string
	results chan assetContractResult
}

type assetContractResult struct {
	reason string
	err    error
}

// StartAssetContractCheck runs ValidateAssetIsContract in the background so callers can overlap
// it with signature verification. The result is delivered by Await.
func StartAssetContractCheck(
	ctx context.Context,
	signer FacilitatorEvmSigner,
	network string,
	asset string,
) *AssetContractCheck {
	check := &AssetContractCheck{
		network: network,
		asset:   asset,
		results: make(chan assetContractResult, 1),
	}
	go func() {
		reason, err := ValidateAssetIsContract(ctx, signer, network, asset)
		check.results <- assetContractResult{reason: reason, err: err}
	}()
	return check
}

// Await returns the check's result, caching a positive one for DefaultAssetContractCacheTTL.
// Recording on Await rather than in the goroutine keeps cache contents independent of goroutine
// scheduling: a check abandoned by an early return cannot publish a result.
func (c *AssetContractCheck) Await() (string, error) {
	result := <-c.results
	if result.err == nil && result.reason == "" {
		globalAssetContractCache.record(
			assetContractCacheKey{network: c.network, asset: NormalizeAddress(c.asset)},
			time.Now(),
		)
	}
	return result.reason, result.err
}
