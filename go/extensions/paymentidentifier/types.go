package paymentidentifier

import (
	"github.com/x402-foundation/x402/go/extensions/types"
)

// Re-export constants and patterns from shared types for convenience
const (
	PAYMENT_IDENTIFIER    = types.PAYMENT_IDENTIFIER
	PAYMENT_ID_MIN_LENGTH = types.PAYMENT_ID_MIN_LENGTH
	PAYMENT_ID_MAX_LENGTH = types.PAYMENT_ID_MAX_LENGTH
)

// PAYMENT_ID_PATTERN is re-exported for convenience
var PAYMENT_ID_PATTERN = types.PAYMENT_ID_PATTERN

// PaymentIdentifierInfo contains the required flag and client-provided ID
type PaymentIdentifierInfo struct {
	Required bool   `json:"required"`
	ID       string `json:"id,omitempty"`
}

// PaymentIdentifierExtension represents the full extension structure
type PaymentIdentifierExtension struct {
	Info   PaymentIdentifierInfo `json:"info"`
	Schema types.JSONSchema      `json:"schema"`
}

// ValidationResult represents the result of validating a payment identifier
type ValidationResult struct {
	Valid  bool
	Errors []string
}
