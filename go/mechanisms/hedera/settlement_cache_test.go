package hedera

import (
	"testing"
	"time"
)

func TestSettlementCacheSeenMark(t *testing.T) {
	cache := NewSettlementCache()
	if cache.Seen("0.0.1@1.000000000") {
		t.Fatal("unexpected hit")
	}
	cache.Confirm("0.0.1@1.000000000")
	if !cache.Seen("0.0.1@1.000000000") {
		t.Fatal("expected hit")
	}
}

func TestSettlementCacheTryClaimConcurrent(t *testing.T) {
	cache := NewSettlementCache()
	const id = "0.0.1@2.000000000"
	if !cache.TryClaim(id) {
		t.Fatal("first claim should succeed")
	}
	if cache.TryClaim(id) {
		t.Fatal("second claim must fail while in-flight")
	}
	if !cache.Seen(id) {
		t.Fatal("in-flight must be visible to Seen")
	}
	cache.Release(id)
	if cache.Seen(id) {
		t.Fatal("release should clear in-flight")
	}
	if !cache.TryClaim(id) {
		t.Fatal("claim after release should succeed")
	}
	cache.Confirm(id)
	if cache.TryClaim(id) {
		t.Fatal("claim after confirm must fail")
	}
	cache.Release(id) // must not clear settled
	if !cache.Seen(id) || cache.TryClaim(id) {
		t.Fatal("settled must survive Release")
	}
}

func TestSettlementCacheTTLExpiry(t *testing.T) {
	now := time.Unix(1_700_000_000, 0)
	cache := &SettlementCache{
		ttl:  time.Minute,
		now:  func() time.Time { return now },
		seen: make(map[string]settlementEntry),
	}
	const id = "0.0.1@3.000000000"
	if !cache.TryClaim(id) {
		t.Fatal("claim")
	}
	cache.Confirm(id)
	if !cache.Seen(id) {
		t.Fatal("expected settled")
	}
	now = now.Add(time.Minute + time.Second)
	if cache.Seen(id) {
		t.Fatal("settled entry should expire after TTL")
	}
	if !cache.TryClaim(id) {
		t.Fatal("claim after expiry should succeed")
	}
}
