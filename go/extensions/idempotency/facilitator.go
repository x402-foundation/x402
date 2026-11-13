package idempotency

import (
	"context"
	"time"

	x402 "github.com/coinbase/x402/go"
)

// IdempotentFacilitator wraps an x402Facilitator with settlement idempotency.
//
// It intercepts Settle() calls to check for cached results before proceeding
// with blockchain transactions. This prevents duplicate transactions when
// clients retry during the pending confirmation window.
//
// All other methods (Verify, GetSupported, hook registration) delegate
// directly to the wrapped facilitator.
type IdempotentFacilitator struct {
	inner        *x402.X402Facilitator
	store        SettlementStore
	keyGenerator KeyGenerator
}

// Wrap creates an IdempotentFacilitator that wraps the given facilitator.
//
// Default configuration:
//   - InMemoryStore with 10-minute TTL
//   - SHA256 key generator
//
// Use functional options to customize:
//
//	facilitator := idempotency.Wrap(baseFacilitator,
//	    idempotency.WithTTL(30 * time.Minute),
//	)
//
//	// Or with custom store
//	facilitator := idempotency.Wrap(baseFacilitator,
//	    idempotency.WithStore(myRedisStore),
//	)
func Wrap(facilitator *x402.X402Facilitator, opts ...Option) *IdempotentFacilitator {
	cfg := &config{
		ttl:          10 * time.Minute,
		keyGenerator: DefaultKeyGenerator,
	}

	for _, opt := range opts {
		opt(cfg)
	}

	store := cfg.store
	if store == nil {
		store = NewInMemoryStore(cfg.ttl)
	}

	return &IdempotentFacilitator{
		inner:        facilitator,
		store:        store,
		keyGenerator: cfg.keyGenerator,
	}
}

// Settle settles a payment with idempotency protection.
//
// Before delegating to the wrapped facilitator, it:
// 1. Generates a unique key from the payment payload
// 2. Checks if a cached result exists (returns immediately if so)
// 3. Waits if another request is already settling this payment
// 4. Caches successful results for future requests
//
// Failed settlements are NOT cached, allowing legitimate retries.
func (f *IdempotentFacilitator) Settle(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.SettleResponse, error) {
	// Generate deduplication key
	cacheKey := f.keyGenerator(payloadBytes)

	// Atomically check cache and mark in-flight to prevent race conditions
	status, result, done := f.store.CheckAndMark(cacheKey)

	switch status {
	case StatusCached:
		return result, nil

	case StatusInFlight:
		// Wait for the in-flight settlement to complete, respecting context cancellation
		result, err := f.store.WaitForResult(ctx, cacheKey, done)
		if err != nil {
			return nil, x402.NewSettleError("context_cancelled", "", "", "", err)
		}
		if result != nil {
			return result, nil
		}
		// In-flight request failed, recursively retry (will get new in-flight slot)
		return f.Settle(ctx, payloadBytes, requirementsBytes)

	case StatusNotFound:
		// This request owns the in-flight slot, proceed with settlement
	}

	// Delegate to wrapped facilitator
	settleResult, settleErr := f.inner.Settle(ctx, payloadBytes, requirementsBytes)

	if settleErr != nil {
		// Don't cache failures - allow retries
		f.store.Fail(cacheKey, done)
		return nil, settleErr
	}

	// Cache successful result
	f.store.Complete(cacheKey, settleResult, done)
	return settleResult, nil
}

// Verify delegates to the wrapped facilitator.
// Verification doesn't need idempotency as it's read-only.
func (f *IdempotentFacilitator) Verify(ctx context.Context, payloadBytes []byte, requirementsBytes []byte) (*x402.VerifyResponse, error) {
	return f.inner.Verify(ctx, payloadBytes, requirementsBytes)
}

// GetSupported delegates to the wrapped facilitator.
func (f *IdempotentFacilitator) GetSupported() x402.SupportedResponse {
	return f.inner.GetSupported()
}

// Inner returns the wrapped facilitator for direct access.
//
// Use this to register hooks, schemes, or extensions on the underlying facilitator:
//
//	wrapped := idempotency.Wrap(baseFacilitator)
//	wrapped.Inner().OnAfterSettle(myHook)
//	wrapped.Inner().Register(networks, scheme)
func (f *IdempotentFacilitator) Inner() *x402.X402Facilitator {
	return f.inner
}

// ============================================================================
// Convenience methods that delegate to Inner()
// ============================================================================

// Register registers a facilitator mechanism for multiple networks (V2).
// This is a convenience method that delegates to Inner().Register().
func (f *IdempotentFacilitator) Register(networks []x402.Network, facilitator x402.SchemeNetworkFacilitator) *IdempotentFacilitator {
	f.inner.Register(networks, facilitator)
	return f
}

// RegisterV1 registers a V1 facilitator mechanism for multiple networks (legacy).
// This is a convenience method that delegates to Inner().RegisterV1().
func (f *IdempotentFacilitator) RegisterV1(networks []x402.Network, facilitator x402.SchemeNetworkFacilitatorV1) *IdempotentFacilitator {
	f.inner.RegisterV1(networks, facilitator)
	return f
}

// RegisterExtension registers a protocol extension.
// This is a convenience method that delegates to Inner().RegisterExtension().
func (f *IdempotentFacilitator) RegisterExtension(extension string) *IdempotentFacilitator {
	f.inner.RegisterExtension(extension)
	return f
}

// OnBeforeVerify adds a before-verify hook.
// This is a convenience method that delegates to Inner().OnBeforeVerify().
func (f *IdempotentFacilitator) OnBeforeVerify(hook x402.FacilitatorBeforeVerifyHook) *IdempotentFacilitator {
	f.inner.OnBeforeVerify(hook)
	return f
}

// OnAfterVerify adds an after-verify hook.
// This is a convenience method that delegates to Inner().OnAfterVerify().
func (f *IdempotentFacilitator) OnAfterVerify(hook x402.FacilitatorAfterVerifyHook) *IdempotentFacilitator {
	f.inner.OnAfterVerify(hook)
	return f
}

// OnVerifyFailure adds a verify-failure hook.
// This is a convenience method that delegates to Inner().OnVerifyFailure().
func (f *IdempotentFacilitator) OnVerifyFailure(hook x402.FacilitatorOnVerifyFailureHook) *IdempotentFacilitator {
	f.inner.OnVerifyFailure(hook)
	return f
}

// OnBeforeSettle adds a before-settle hook.
// This is a convenience method that delegates to Inner().OnBeforeSettle().
func (f *IdempotentFacilitator) OnBeforeSettle(hook x402.FacilitatorBeforeSettleHook) *IdempotentFacilitator {
	f.inner.OnBeforeSettle(hook)
	return f
}

// OnAfterSettle adds an after-settle hook.
// This is a convenience method that delegates to Inner().OnAfterSettle().
func (f *IdempotentFacilitator) OnAfterSettle(hook x402.FacilitatorAfterSettleHook) *IdempotentFacilitator {
	f.inner.OnAfterSettle(hook)
	return f
}

// OnSettleFailure adds a settle-failure hook.
// This is a convenience method that delegates to Inner().OnSettleFailure().
func (f *IdempotentFacilitator) OnSettleFailure(hook x402.FacilitatorOnSettleFailureHook) *IdempotentFacilitator {
	f.inner.OnSettleFailure(hook)
	return f
}
