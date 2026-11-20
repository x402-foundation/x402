package idempotency

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	x402 "github.com/coinbase/x402/go"
)

// SettlementStatus represents the result of checking the store.
type SettlementStatus int

const (
	// StatusNotFound means no cached result and no in-flight request.
	StatusNotFound SettlementStatus = iota
	// StatusCached means a cached result was found.
	StatusCached
	// StatusInFlight means another request is currently processing this settlement.
	StatusInFlight
)

// SettlementStore defines the interface for settlement idempotency storage.
// Implementations must be safe for concurrent use.
//
// The interface is designed to support both in-memory and distributed backends
// (Redis, database, etc.) for different deployment scenarios.
type SettlementStore interface {
	// CheckAndMark atomically checks the store and marks the key as in-flight if needed.
	//
	// Returns:
	//   - StatusCached + result + nil: A cached result exists, return it immediately
	//   - StatusInFlight + nil + done: Another request is processing, wait on done channel
	//   - StatusNotFound + nil + done: This request should proceed (now marked in-flight)
	//
	// The done channel is used to signal completion to waiting goroutines.
	// It must be passed to Complete() or Fail() when the operation finishes.
	CheckAndMark(key string) (SettlementStatus, *x402.SettleResponse, chan struct{})

	// WaitForResult waits for an in-flight request to complete, respecting context cancellation.
	//
	// Returns:
	//   - The cached result if the in-flight request succeeded
	//   - nil if the in-flight request failed (caller should retry)
	//   - Error if context was cancelled
	WaitForResult(ctx context.Context, key string, done chan struct{}) (*x402.SettleResponse, error)

	// Complete marks a settlement as complete, caches the response,
	// and signals any waiting goroutines via the done channel.
	//
	// The done channel must be the same one returned by CheckAndMark.
	Complete(key string, response *x402.SettleResponse, done chan struct{})

	// Fail removes the in-flight marker without caching a result,
	// signaling waiters that they should retry.
	//
	// The done channel must be the same one returned by CheckAndMark.
	Fail(key string, done chan struct{})
}

// KeyGenerator generates unique keys for settlement deduplication.
// The key should uniquely identify a settlement attempt.
type KeyGenerator func(payloadBytes []byte) string

// DefaultKeyGenerator generates a settlement key using SHA256 hash of the payload bytes.
// The payment payload includes the authorization signature and nonce, ensuring
// uniqueness per payment attempt.
func DefaultKeyGenerator(payloadBytes []byte) string {
	hash := sha256.Sum256(payloadBytes)
	return hex.EncodeToString(hash[:])
}
