// Package idempotency provides settlement idempotency as an opt-in extension for x402 facilitators.
//
// # Overview
//
// This package implements transaction idempotency for the x402 facilitator's Settle operation.
// It prevents duplicate blockchain transactions when clients retry requests during the
// pending confirmation window (before blockchain-level nonce protection activates).
//
// # Why an Extension?
//
// The core x402 protocol is designed to be stateless, supporting diverse deployment scenarios:
//   - Lambda/serverless functions with cold starts
//   - Load-balanced clusters
//   - Single instance deployments
//
// By implementing idempotency as an extension, facilitators can opt-in when appropriate
// and choose the cache backend that matches their deployment model.
//
// # Usage
//
// Basic usage with default in-memory cache:
//
//	baseFacilitator := x402.Newx402Facilitator()
//	baseFacilitator.Register(networks, evmScheme)
//
//	// Wrap with idempotency (opt-in)
//	facilitator := idempotency.Wrap(baseFacilitator)
//
// Custom TTL:
//
//	facilitator := idempotency.Wrap(baseFacilitator,
//	    idempotency.WithTTL(30 * time.Minute),
//	)
//
// Custom cache backend (e.g., Redis):
//
//	redisStore := NewRedisStore(redisClient, 10*time.Minute)
//	facilitator := idempotency.Wrap(baseFacilitator,
//	    idempotency.WithStore(redisStore),
//	)
//
// # Implementing Custom Stores
//
// For distributed deployments, implement the SettlementStore interface with your
// preferred backend (Redis, database, etc.). The interface provides:
//   - CheckAndMark: Atomic check-and-mark for deduplication
//   - WaitForResult: Wait for in-flight requests to complete
//   - Complete: Cache successful results
//   - Fail: Clear in-flight marker on failure (allows retry)
//
// # How It Works
//
// 1. On Settle(), a unique key is generated from the payment payload (SHA256 hash by default)
// 2. The store atomically checks for cached result or in-flight request
// 3. If cached: return immediately without blockchain transaction
// 4. If in-flight: wait for the other request to complete, then return its result
// 5. Otherwise: proceed with settlement, then cache the result
//
// Failed settlements are NOT cached, allowing legitimate retries.
package idempotency
