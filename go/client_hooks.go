package x402

import (
	"context"
)

// ============================================================================
// Client Hook Context Types
// ============================================================================

// PaymentCreationContext contains information passed to payment creation hooks
// Uses view interfaces for version-agnostic hooks
type PaymentCreationContext struct {
	Ctx                  context.Context
	Version              int // V1 or V2
	SelectedRequirements PaymentRequirementsView
}

// PaymentCreatedContext contains payment creation result and context
type PaymentCreatedContext struct {
	PaymentCreationContext
	Payload PaymentPayloadView
}

// PaymentCreationFailureContext contains payment creation failure and context
type PaymentCreationFailureContext struct {
	PaymentCreationContext
	Error error
}

// ============================================================================
// Client Hook Result Types
// ============================================================================

// BeforePaymentCreationHookResult represents the result of a "before payment creation" hook
// If Abort is true, the payment creation will be aborted with the given Reason
type BeforePaymentCreationHookResult struct {
	Abort  bool
	Reason string
}

// PaymentCreationFailureHookResult represents the result of a payment creation failure hook
// If Recovered is true, the hook has recovered from the failure with the given payload
type PaymentCreationFailureHookResult struct {
	Recovered bool
	Payload   PaymentPayloadView
}

// ============================================================================
// Client Hook Function Types
// ============================================================================

// BeforePaymentCreationHook is called before payment payload creation
// If it returns a result with Abort=true, payment creation will be aborted
// and an error will be returned with the provided reason
type BeforePaymentCreationHook func(PaymentCreationContext) (*BeforePaymentCreationHookResult, error)

// AfterPaymentCreationHook is called after successful payment payload creation
// Any error returned will be logged but will not affect the payment creation result
type AfterPaymentCreationHook func(PaymentCreatedContext) error

// OnPaymentCreationFailureHook is called when payment payload creation fails
// If it returns a result with Recovered=true, the provided PaymentPayload
// will be returned instead of the error
type OnPaymentCreationFailureHook func(PaymentCreationFailureContext) (*PaymentCreationFailureHookResult, error)

// OnPaymentResponseHook is called by the transport after each paid response
// (HTTP 200 with PAYMENT-RESPONSE, or corrective HTTP 402 with PAYMENT-REQUIRED).
// Mirrors the TS x402Client.onPaymentResponse user-level hook.
//
// Returning Recovered=true on a corrective 402 instructs the transport to retry
// once with a freshly built payment payload. The first hook to return Recovered
// wins; subsequent hooks still run for instrumentation.
type OnPaymentResponseHook func(context.Context, PaymentResponseContext) (PaymentResponseResult, error)

// ============================================================================
// Client Hook Registration Options
// ============================================================================

// WithBeforePaymentCreationHook registers a hook to execute before payment creation
func WithBeforePaymentCreationHook(hook BeforePaymentCreationHook) ClientOption {
	return func(c *x402Client) {
		c.beforePaymentCreationHooks = append(c.beforePaymentCreationHooks, hook)
	}
}

// WithAfterPaymentCreationHook registers a hook to execute after successful payment creation
func WithAfterPaymentCreationHook(hook AfterPaymentCreationHook) ClientOption {
	return func(c *x402Client) {
		c.afterPaymentCreationHooks = append(c.afterPaymentCreationHooks, hook)
	}
}

// WithOnPaymentCreationFailureHook registers a hook to execute when payment creation fails
func WithOnPaymentCreationFailureHook(hook OnPaymentCreationFailureHook) ClientOption {
	return func(c *x402Client) {
		c.onPaymentCreationFailureHooks = append(c.onPaymentCreationFailureHooks, hook)
	}
}

// WithOnPaymentResponseHook registers a hook to execute after each paid response.
func WithOnPaymentResponseHook(hook OnPaymentResponseHook) ClientOption {
	return func(c *x402Client) {
		c.onPaymentResponseHooks = append(c.onPaymentResponseHooks, hook)
	}
}
