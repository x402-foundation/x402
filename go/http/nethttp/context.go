package nethttp

import (
	"context"

	"github.com/x402-foundation/x402/go/types"
)

// contextKey is a private type for context keys defined in this package.
type contextKey string

const (
	// payloadContextKey is the context key for the payment payload.
	payloadContextKey contextKey = "x402_payload"

	// requirementsContextKey is the context key for the payment requirements.
	requirementsContextKey contextKey = "x402_requirements"
)

// PayloadFromContext retrieves the payment payload from the request context.
// Returns nil and false if no payload is present.
func PayloadFromContext(ctx context.Context) (*types.PaymentPayload, bool) {
	val := ctx.Value(payloadContextKey)
	if val == nil {
		return nil, false
	}
	payload, ok := val.(*types.PaymentPayload)
	return payload, ok
}

// RequirementsFromContext retrieves the payment requirements from the request context.
// Returns nil and false if no requirements are present.
func RequirementsFromContext(ctx context.Context) (*types.PaymentRequirements, bool) {
	val := ctx.Value(requirementsContextKey)
	if val == nil {
		return nil, false
	}
	reqs, ok := val.(*types.PaymentRequirements)
	return reqs, ok
}

// withPayload returns a new context with the payment payload attached.
func withPayload(ctx context.Context, payload *types.PaymentPayload) context.Context {
	return context.WithValue(ctx, payloadContextKey, payload)
}

// withRequirements returns a new context with the payment requirements attached.
func withRequirements(ctx context.Context, reqs *types.PaymentRequirements) context.Context {
	return context.WithValue(ctx, requirementsContextKey, reqs)
}
