package x402

import (
	"context"
)

// ============================================================================
// Facilitator Hook Context Types
// ============================================================================

// FacilitatorVerifyContext contains information passed to facilitator verify hooks
// Uses view interfaces for version-agnostic hooks
// PayloadBytes and RequirementsBytes provide escape hatch for extensions (e.g., Bazaar)
type FacilitatorVerifyContext struct {
	Ctx               context.Context
	Payload           PaymentPayloadView
	Requirements      PaymentRequirementsView
	PayloadBytes      []byte // Raw bytes for extensions needing full data
	RequirementsBytes []byte // Raw bytes for extensions needing full data
}

// FacilitatorVerifyResultContext contains facilitator verify operation result and context
type FacilitatorVerifyResultContext struct {
	FacilitatorVerifyContext
	Result *VerifyResponse
}

// FacilitatorVerifyFailureContext contains facilitator verify operation failure and context
type FacilitatorVerifyFailureContext struct {
	FacilitatorVerifyContext
	Error error
}

// FacilitatorSettleContext contains information passed to facilitator settle hooks
// Uses view interfaces for version-agnostic hooks
// PayloadBytes and RequirementsBytes provide escape hatch for extensions (e.g., Bazaar)
type FacilitatorSettleContext struct {
	Ctx               context.Context
	Payload           PaymentPayloadView
	Requirements      PaymentRequirementsView
	PayloadBytes      []byte // Raw bytes for extensions needing full data
	RequirementsBytes []byte // Raw bytes for extensions needing full data
}

// FacilitatorSettleResultContext contains facilitator settle operation result and context
type FacilitatorSettleResultContext struct {
	FacilitatorSettleContext
	Result *SettleResponse
}

// FacilitatorSettleFailureContext contains facilitator settle operation failure and context
type FacilitatorSettleFailureContext struct {
	FacilitatorSettleContext
	Error error
}

// ============================================================================
// Facilitator Hook Result Types
// ============================================================================

// FacilitatorBeforeHookResult represents the result of a facilitator "before" hook
// If Abort is true, the operation will be aborted with the given Reason
type FacilitatorBeforeHookResult struct {
	Abort   bool
	Reason  string
	Message string
}

// FacilitatorVerifyFailureHookResult represents the result of a facilitator verify failure hook
// If Recovered is true, the hook has recovered from the failure with the given result
type FacilitatorVerifyFailureHookResult struct {
	Recovered bool
	Result    *VerifyResponse
}

// FacilitatorSettleFailureHookResult represents the result of a facilitator settle failure hook
type FacilitatorSettleFailureHookResult struct {
	Recovered bool
	Result    *SettleResponse
}

// ============================================================================
// Facilitator Hook Function Types
// ============================================================================

// FacilitatorBeforeVerifyHook is called before facilitator payment verification
// If it returns a result with Abort=true, verification will be skipped
// and an invalid VerifyResponse will be returned with the provided reason
type FacilitatorBeforeVerifyHook func(FacilitatorVerifyContext) (*FacilitatorBeforeHookResult, error)

// FacilitatorAfterVerifyHook is called after successful facilitator payment verification
// Any error returned will be logged but will not affect the verification result
type FacilitatorAfterVerifyHook func(FacilitatorVerifyResultContext) error

// FacilitatorOnVerifyFailureHook is called when facilitator payment verification fails
// If it returns a result with Recovered=true, the provided VerifyResponse
// will be returned instead of the error
type FacilitatorOnVerifyFailureHook func(FacilitatorVerifyFailureContext) (*FacilitatorVerifyFailureHookResult, error)

// FacilitatorBeforeSettleHook is called before facilitator payment settlement
// If it returns a result with Abort=true, settlement will be aborted
// and an error will be returned with the provided reason
type FacilitatorBeforeSettleHook func(FacilitatorSettleContext) (*FacilitatorBeforeHookResult, error)

// FacilitatorAfterSettleHook is called after successful facilitator payment settlement
// Any error returned will be logged but will not affect the settlement result
type FacilitatorAfterSettleHook func(FacilitatorSettleResultContext) error

// FacilitatorOnSettleFailureHook is called when facilitator payment settlement fails
// If it returns a result with Recovered=true, the provided SettleResponse
// will be returned instead of the error
type FacilitatorOnSettleFailureHook func(FacilitatorSettleFailureContext) (*FacilitatorSettleFailureHookResult, error)
