package idempotency

import "time"

// config holds the configuration for IdempotentFacilitator.
type config struct {
	ttl          time.Duration
	store        SettlementStore
	keyGenerator KeyGenerator
}

// Option configures an IdempotentFacilitator.
type Option func(*config)

// WithTTL sets the cache TTL for successful settlements.
//
// Only applies when using the default InMemoryStore.
// If WithStore is also specified, this option is ignored
// (configure TTL on your custom store instead).
//
// Default: 10 minutes
func WithTTL(ttl time.Duration) Option {
	return func(c *config) {
		c.ttl = ttl
	}
}

// WithStore sets a custom SettlementStore implementation.
//
// Use this for distributed cache backends like Redis or a database.
// When specified, WithTTL is ignored (configure TTL on your store).
//
// Example:
//
//	redisStore := NewRedisStore(redisClient, 10*time.Minute)
//	facilitator := idempotency.Wrap(baseFacilitator,
//	    idempotency.WithStore(redisStore),
//	)
func WithStore(store SettlementStore) Option {
	return func(c *config) {
		c.store = store
	}
}

// WithKeyGenerator sets a custom key generation function.
//
// By default, uses SHA256 hash of the payload bytes. Custom generators
// can be useful for:
//   - Including additional context in the key
//   - Using a different hash algorithm
//   - Generating shorter keys for storage optimization
//
// The key must uniquely identify a settlement attempt to prevent
// false positive deduplication.
func WithKeyGenerator(gen KeyGenerator) Option {
	return func(c *config) {
		c.keyGenerator = gen
	}
}
