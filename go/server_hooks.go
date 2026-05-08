package x402

import (
	"context"
	"sync"
)

// ============================================================================
// Resource Server Hook Context Types
// ============================================================================

// VerifyContext contains information passed to verify hooks
// Uses view interfaces for version-agnostic hooks
// PayloadBytes and RequirementsBytes provide escape hatch for extensions (e.g., Bazaar)
type VerifyContext struct {
	Ctx          context.Context
	Payload      PaymentPayloadView
	Requirements PaymentRequirementsView
	// DeclaredExtensions carries the extension declarations attached to the
	// route. Extension hooks gate on `DeclaredExtensions[extKey]` being set
	// before firing — mirrors TS `ctx.declaredExtensions[extensionKey]`.
	DeclaredExtensions map[string]interface{}
	PayloadBytes       []byte // Raw bytes for extensions needing full data
	RequirementsBytes  []byte // Raw bytes for extensions needing full data
}

// VerifyResultContext contains verify operation result and context
type VerifyResultContext struct {
	VerifyContext
	Result *VerifyResponse
}

// VerifyFailureContext contains verify operation failure and context
type VerifyFailureContext struct {
	VerifyContext
	Error error
}

// SkipHandlerDirective is an optional acknowledgement body returned to the caller
// when an AfterVerifyHook requests that the resource handler be skipped for a
// self-contained operation. Travels in-process only —
// never on the facilitator wire.
type SkipHandlerDirective struct {
	ContentType string
	Body        interface{}
}

// AfterVerifyResult is the optional return value of an AfterVerifyHook.
// When SkipHandler is true, the resource handler is bypassed and settlement is
// performed inline; the optional Response is used to craft the success body.
type AfterVerifyResult struct {
	SkipHandler bool
	Response    *SkipHandlerDirective
}

// SettleContext contains information passed to settle hooks
// Uses view interfaces for version-agnostic hooks
// PayloadBytes and RequirementsBytes provide escape hatch for extensions (e.g., Bazaar)
type SettleContext struct {
	Ctx          context.Context
	Payload      PaymentPayloadView
	Requirements PaymentRequirementsView
	// DeclaredExtensions carries the extension declarations attached to the
	// route. Extension hooks gate on `DeclaredExtensions[extKey]` being set
	// before firing — mirrors TS `ctx.declaredExtensions[extensionKey]`.
	DeclaredExtensions map[string]interface{}
	PayloadBytes       []byte // Raw bytes for extensions needing full data
	RequirementsBytes  []byte // Raw bytes for extensions needing full data
}

// SettleResultContext contains settle operation result and context
type SettleResultContext struct {
	SettleContext
	Result *SettleResponse
}

// SettleFailureContext contains settle operation failure and context
type SettleFailureContext struct {
	SettleContext
	Error error
}

// VerifiedPaymentCancellationReason describes why a verified payment is being canceled
// before settlement runs. Mirrors TS `VerifiedPaymentCancellationReason`.
type VerifiedPaymentCancellationReason string

const (
	// CancellationReasonHandlerThrew indicates the resource handler panicked or returned an error.
	CancellationReasonHandlerThrew VerifiedPaymentCancellationReason = "handler_threw"
	// CancellationReasonHandlerFailed indicates the resource handler completed but with a failing
	// response status (>= 400).
	CancellationReasonHandlerFailed VerifiedPaymentCancellationReason = "handler_failed"
)

// VerifiedPaymentCanceledContext is delivered to OnVerifiedPaymentCanceled hooks when a
// verified payment is canceled before settlement.
type VerifiedPaymentCanceledContext struct {
	SettleContext
	Reason         VerifiedPaymentCancellationReason
	Err            error
	ResponseStatus int
}

// VerifiedPaymentCancelOptions describes a single cancellation event.
type VerifiedPaymentCancelOptions struct {
	Reason         VerifiedPaymentCancellationReason
	Err            error
	ResponseStatus int
}

// PaymentCancellationDispatcher fires onVerifiedPaymentCanceled hooks at most once.
type PaymentCancellationDispatcher struct {
	once sync.Once
	fire func(VerifiedPaymentCancelOptions)
}

// Cancel fires the underlying hooks. Safe to call multiple times — only the first call wins.
func (d *PaymentCancellationDispatcher) Cancel(opts VerifiedPaymentCancelOptions) {
	if d == nil || d.fire == nil {
		return
	}
	d.once.Do(func() { d.fire(opts) })
}

// ============================================================================
// Resource Server Hook Result Types
// ============================================================================

// BeforeHookResult represents the result of a "before" hook.
// If Abort is true, the operation will be aborted with the given Reason.
// If Skip is true, the operation will be short-circuited; the hook supplies
// either SkipResult (settle hooks) or SkipVerifyResult (verify hooks). The
// batched scheme uses this to handle voucher payloads without on-chain
// settlement and to short-circuit verification when local channel state is
// fresh enough to verify against.
type BeforeHookResult struct {
	Abort            bool
	Reason           string
	Message          string
	Skip             bool
	SkipResult       *SettleResponse
	SkipVerifyResult *VerifyResponse
}

// VerifyFailureHookResult represents the result of a verify failure hook
// If Recovered is true, the hook has recovered from the failure with the given result
type VerifyFailureHookResult struct {
	Recovered bool
	Result    *VerifyResponse
}

// SettleFailureHookResult represents the result of a settle failure hook
type SettleFailureHookResult struct {
	Recovered bool
	Result    *SettleResponse
}

// ============================================================================
// Resource Server Hook Function Types
// ============================================================================

// BeforeVerifyHook is called before payment verification
// If it returns a result with Abort=true, verification will be skipped
// and an invalid VerifyResponse will be returned with the provided reason
type BeforeVerifyHook func(VerifyContext) (*BeforeHookResult, error)

// AfterVerifyHook is called after successful payment verification.
// Any error returned will be logged but will not affect the verification result.
// Returning an AfterVerifyResult with SkipHandler=true signals the HTTP layer to
// bypass the resource handler and perform settlement inline (e.g. cooperative refund).
// The last hook to return a SkipHandler directive wins.
type AfterVerifyHook func(VerifyResultContext) (*AfterVerifyResult, error)

// OnVerifyFailureHook is called when payment verification fails
// If it returns a result with Recovered=true, the provided VerifyResponse
// will be returned instead of the error
type OnVerifyFailureHook func(VerifyFailureContext) (*VerifyFailureHookResult, error)

// BeforeSettleHook is called before payment settlement
// If it returns a result with Abort=true, settlement will be aborted
// and an error will be returned with the provided reason
type BeforeSettleHook func(SettleContext) (*BeforeHookResult, error)

// AfterSettleHook is called after successful payment settlement
// Any error returned will be logged but will not affect the settlement result
type AfterSettleHook func(SettleResultContext) error

// OnSettleFailureHook is called when payment settlement fails
// If it returns a result with Recovered=true, the provided SettleResponse
// will be returned instead of the error
type OnSettleFailureHook func(SettleFailureContext) (*SettleFailureHookResult, error)

// OnVerifiedPaymentCanceledHook is called when a verified payment is canceled
// before settlement runs (e.g. resource handler error or non-2xx response).
// Returned errors are logged but do not affect the response.
type OnVerifiedPaymentCanceledHook func(VerifiedPaymentCanceledContext) error

// ============================================================================
// Resource Server Hook Registration Options
// ============================================================================

// WithBeforeVerifyHook registers a hook to execute before payment verification
func WithBeforeVerifyHook(hook BeforeVerifyHook) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.beforeVerifyHooks = append(s.beforeVerifyHooks, hook)
	}
}

// WithAfterVerifyHook registers a hook to execute after successful payment verification
func WithAfterVerifyHook(hook AfterVerifyHook) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.afterVerifyHooks = append(s.afterVerifyHooks, hook)
	}
}

// WithOnVerifyFailureHook registers a hook to execute when payment verification fails
func WithOnVerifyFailureHook(hook OnVerifyFailureHook) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.onVerifyFailureHooks = append(s.onVerifyFailureHooks, hook)
	}
}

// WithBeforeSettleHook registers a hook to execute before payment settlement
func WithBeforeSettleHook(hook BeforeSettleHook) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.beforeSettleHooks = append(s.beforeSettleHooks, hook)
	}
}

// WithAfterSettleHook registers a hook to execute after successful payment settlement
func WithAfterSettleHook(hook AfterSettleHook) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.afterSettleHooks = append(s.afterSettleHooks, hook)
	}
}

// WithOnSettleFailureHook registers a hook to execute when payment settlement fails
func WithOnSettleFailureHook(hook OnSettleFailureHook) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.onSettleFailureHooks = append(s.onSettleFailureHooks, hook)
	}
}

// WithOnVerifiedPaymentCanceledHook registers a hook fired when a verified payment
// is canceled before settlement (handler error or non-2xx response).
func WithOnVerifiedPaymentCanceledHook(hook OnVerifiedPaymentCanceledHook) ResourceServerOption {
	return func(s *x402ResourceServer) {
		s.onVerifiedPaymentCanceledHooks = append(s.onVerifiedPaymentCanceledHooks, hook)
	}
}

// ============================================================================
// Scheme-Provided Hook Provider Interfaces (Auto-Wiring)
// ============================================================================
//
// SchemeNetworkServer implementations may optionally satisfy these interfaces to
// have their lifecycle hooks auto-registered when the scheme is registered with
// an x402ResourceServer (mirrors the TS schemeHooks field). User code does not
// need to call OnBeforeVerify / OnAfterVerify / OnBeforeSettle / OnAfterSettle /
// OnVerifiedPaymentCanceled manually — Register inspects the scheme via type
// assertion and wires hooks automatically.

// BeforeVerifyHookProvider is implemented by schemes that contribute a
// BeforeVerifyHook to the resource server's lifecycle pipeline.
type BeforeVerifyHookProvider interface {
	BeforeVerifyHook() BeforeVerifyHook
}

// AfterVerifyHookProvider is implemented by schemes that contribute an
// AfterVerifyHook to the resource server's lifecycle pipeline.
type AfterVerifyHookProvider interface {
	AfterVerifyHook() AfterVerifyHook
}

// OnVerifyFailureHookProvider is implemented by schemes that contribute an
// OnVerifyFailureHook to the resource server's lifecycle pipeline.
type OnVerifyFailureHookProvider interface {
	OnVerifyFailureHook() OnVerifyFailureHook
}

// BeforeSettleHookProvider is implemented by schemes that contribute a
// BeforeSettleHook to the resource server's lifecycle pipeline.
type BeforeSettleHookProvider interface {
	BeforeSettleHook() BeforeSettleHook
}

// AfterSettleHookProvider is implemented by schemes that contribute an
// AfterSettleHook to the resource server's lifecycle pipeline.
type AfterSettleHookProvider interface {
	AfterSettleHook() AfterSettleHook
}

// OnSettleFailureHookProvider is implemented by schemes that contribute an
// OnSettleFailureHook to the resource server's lifecycle pipeline.
type OnSettleFailureHookProvider interface {
	OnSettleFailureHook() OnSettleFailureHook
}

// OnVerifiedPaymentCanceledHookProvider is implemented by schemes that contribute
// an OnVerifiedPaymentCanceledHook to the resource server's lifecycle pipeline.
type OnVerifiedPaymentCanceledHookProvider interface {
	OnVerifiedPaymentCanceledHook() OnVerifiedPaymentCanceledHook
}

// ============================================================================
// Scheme-Level Enrichment Hook Provider Interfaces
// ============================================================================
//
// These complement the lifecycle hooks above. A scheme exposes them when it
// needs to enrich settlement payload (pre-facilitator) or settlement
// response (post-facilitator) with server-owned fields. Mirrors TS
// `enrichSettlementPayload` / `enrichSettlementResponse` on
// `BatchSettlementEvmScheme`. Returned maps are merged ADDITIVELY — the
// framework rejects any attempt to overwrite existing fields via
// AssertAdditivePayloadEnrichment / AssertAdditiveSettlementExtra.

// EnrichSettlementPayloadProvider is implemented by schemes that need to
// add server-owned fields to the payment payload before the facilitator
// settles. Return nil/empty for no-op. The framework asserts the result is
// additive (no existing payload key may be present in the returned map)
// before merging.
type EnrichSettlementPayloadProvider interface {
	EnrichSettlementPayload(ctx SettleContext) (map[string]interface{}, error)
}

// EnrichSettlementResponseProvider is implemented by schemes that need to
// add server-owned fields to the facilitator's settle response `extra`.
// Return nil/empty for no-op. The framework asserts the result is additive
// (no existing extra key may be present in the returned map, recursively
// for nested maps) before deep-merging.
type EnrichSettlementResponseProvider interface {
	EnrichSettlementResponse(ctx SettleResultContext) (map[string]interface{}, error)
}

// ============================================================================
// Extension Hook Provider Interfaces
// ============================================================================
//
// ResourceServerExtension implementations may also satisfy the per-phase hook
// provider interfaces below to install hooks that fire ONLY when the
// extension key is present in the request's `declaredExtensions` map. This
// matches TS `ResourceServerExtensionHooks` — hooks gate on
// `ctx.declaredExtensions[extensionKey] !== undefined`.
//
// Hooks registered this way run AFTER manual hooks and the matched scheme's
// hook for the same phase (mirrors TS hook ordering).

// ResourceServerExtensionHookProvider lets an extension expose any subset of
// the seven lifecycle hooks. Returning nil from any phase means "no hook
// for that phase" — the server skips it.
type ResourceServerExtensionHookProvider interface {
	ResourceServerExtensionHooks() ResourceServerExtensionHooks
}

// ResourceServerExtensionHooks is an extension's optional bundle of
// lifecycle hooks. Mirrors the TS `ResourceServerExtensionHooks` interface
// shape — fields left nil mean "no hook for that phase".
type ResourceServerExtensionHooks struct {
	OnBeforeVerify            BeforeVerifyHook
	OnAfterVerify             AfterVerifyHook
	OnVerifyFailure           OnVerifyFailureHook
	OnBeforeSettle            BeforeSettleHook
	OnAfterSettle             AfterSettleHook
	OnSettleFailure           OnSettleFailureHook
	OnVerifiedPaymentCanceled OnVerifiedPaymentCanceledHook
}
