package x402

import "fmt"

// PaymentError represents a payment-specific error
type PaymentError struct {
	Code    string                 `json:"code"`
	Message string                 `json:"message"`
	Details map[string]interface{} `json:"details,omitempty"`
}

func (e *PaymentError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Common error codes
const (
	ErrCodeInvalidPayment     = "invalid_payment"
	ErrCodePaymentRequired    = "payment_required"
	ErrCodeInsufficientFunds  = "insufficient_funds"
	ErrCodeNetworkMismatch    = "network_mismatch"
	ErrCodeSchemeMismatch     = "scheme_mismatch"
	ErrCodeSignatureInvalid   = "signature_invalid"
	ErrCodePaymentExpired     = "payment_expired"
	ErrCodeSettlementFailed   = "settlement_failed"
	ErrCodeUnsupportedScheme  = "unsupported_scheme"
	ErrCodeUnsupportedNetwork = "unsupported_network"
)

// Facilitator error constants
const (
	ErrInvalidVersion          = "invalid_version"
	ErrInvalidV1Payload        = "invalid_v1_payload"
	ErrInvalidV1Requirements   = "invalid_v1_requirements"
	ErrInvalidV2Payload        = "invalid_v2_payload"
	ErrInvalidV2Requirements   = "invalid_v2_requirements"
	ErrNoFacilitatorForNetwork = "no_facilitator_for_network"
	ErrInvalidResponse         = "invalid_response"
)

// Server error constants
const (
	ErrFailedToMarshalPayload      = "failed_to_marshal_payload"
	ErrFailedToMarshalRequirements = "failed_to_marshal_requirements"
)

// NewPaymentError creates a new payment error
func NewPaymentError(code, message string, details map[string]interface{}) *PaymentError {
	return &PaymentError{
		Code:    code,
		Message: message,
		Details: details,
	}
}

// VerifyError represents a payment verification failure
// All verification failures (business logic and system errors) are returned as errors
type VerifyError struct {
	InvalidReason  string // Error reason/code (e.g., "insufficient_balance", "invalid_signature")
	Payer          string // Payer address (if known)
	InvalidMessage string // Optional invalid message details
}

// Error implements the error interface
func (e *VerifyError) Error() string {
	if e.InvalidMessage != "" {
		return fmt.Sprintf("%s: %s", e.InvalidReason, e.InvalidMessage)
	}
	return e.InvalidReason
}

// NewVerifyError creates a new verification error
//
// Args:
//
//	reason: Error reason/code
//	payer: Payer address (empty string if unknown)
//	network: Network identifier (empty string if unknown)
//	message: Optional invalid message details
//
// Returns:
//
//	*VerifyError
func NewVerifyError(reason string, payer string, message string) *VerifyError {
	return &VerifyError{
		InvalidReason:  reason,
		Payer:          payer,
		InvalidMessage: message,
	}
}

// SettleError represents a payment settlement failure
// All settlement failures (business logic and system errors) are returned as errors
type SettleError struct {
	ErrorReason  string  // Error reason/code (e.g., "transaction_failed", "insufficient_balance")
	Payer        string  // Payer address (if known)
	Network      Network // Network identifier
	Transaction  string  // Transaction hash (if settlement was attempted)
	ErrorMessage string  // Optional error message details
}

// Error implements the error interface
func (e *SettleError) Error() string {
	if e.ErrorMessage != "" {
		return fmt.Sprintf("%s: %s", e.ErrorReason, e.ErrorMessage)
	}
	return e.ErrorReason
}

// NewSettleError creates a new settlement error
//
// Args:
//
//	reason: Error reason/code
//	payer: Payer address (empty string if unknown)
//	network: Network identifier
//	transaction: Transaction hash (empty string if not submitted)
//	err: Optional underlying error
//
// Returns:
//
//	*SettleError
func NewSettleError(reason string, payer string, network Network, transaction string, message string) *SettleError {
	return &SettleError{
		ErrorReason:  reason,
		Payer:        payer,
		Network:      network,
		Transaction:  transaction,
		ErrorMessage: message,
	}
}
