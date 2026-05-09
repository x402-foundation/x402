package paymentidentifier

import (
	"encoding/json"
	"fmt"

	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/types"
)

// parseExtension converts an extension interface{} to a PaymentIdentifierExtension.
// This centralizes the marshal/unmarshal pattern used throughout the package.
func parseExtension(extension interface{}) (*PaymentIdentifierExtension, error) {
	extBytes, err := json.Marshal(extension)
	if err != nil {
		return nil, fmt.Errorf("failed to marshal extension: %w", err)
	}

	var ext PaymentIdentifierExtension
	if err := json.Unmarshal(extBytes, &ext); err != nil {
		return nil, fmt.Errorf("failed to unmarshal extension: %w", err)
	}

	return &ext, nil
}

// getPaymentIdentifierExtension extracts the raw payment-identifier extension from a payload.
// Returns the raw extension and true if found, or nil and false if not present.
func getPaymentIdentifierExtension(payload x402.PaymentPayload) (interface{}, bool) {
	if payload.Extensions == nil {
		return nil, false
	}
	ext, ok := payload.Extensions[PAYMENT_IDENTIFIER]
	return ext, ok
}

// IsPaymentIdentifierExtension checks if an object is a valid payment-identifier extension structure.
//
// This checks for the basic structure (info object with required boolean),
// but does not validate the id format if present.
//
// Args:
//   - extension: The object to check
//
// Returns:
//   - True if the object has the expected payment-identifier extension structure
func IsPaymentIdentifierExtension(extension interface{}) bool {
	if extension == nil {
		return false
	}

	// Try to marshal and unmarshal to check structure
	extBytes, err := json.Marshal(extension)
	if err != nil {
		return false
	}

	// Check for the basic structure: must have "info" with "required" boolean
	var raw struct {
		Info *struct {
			Required *bool `json:"required"`
		} `json:"info"`
	}
	if err := json.Unmarshal(extBytes, &raw); err != nil {
		return false
	}

	// Must have info object with required field
	if raw.Info == nil || raw.Info.Required == nil {
		return false
	}

	return true
}

// ValidatePaymentIdentifier validates a payment-identifier extension object.
//
// Checks both the structure (using JSON Schema) and the ID format.
//
// Args:
//   - extension: The extension object to validate
//
// Returns:
//   - ValidationResult with errors if invalid
func ValidatePaymentIdentifier(extension interface{}) ValidationResult {
	if extension == nil {
		return ValidationResult{
			Valid:  false,
			Errors: []string{"Extension must be an object"},
		}
	}

	ext, err := parseExtension(extension)
	if err != nil {
		return ValidationResult{
			Valid:  false,
			Errors: []string{fmt.Sprintf("Extension must have an 'info' property: %v", err)},
		}
	}

	// Validate ID format if provided
	if ext.Info.ID != "" && !IsValidPaymentID(ext.Info.ID) {
		return ValidationResult{
			Valid: false,
			Errors: []string{
				fmt.Sprintf("Invalid payment ID format. ID must be %d-%d characters and contain only alphanumeric characters, hyphens, and underscores.",
					PAYMENT_ID_MIN_LENGTH, PAYMENT_ID_MAX_LENGTH),
			},
		}
	}

	return ValidationResult{Valid: true}
}

// ExtractPaymentIdentifier extracts the payment identifier from a PaymentPayload.
//
// Args:
//   - payload: The payment payload to extract from
//   - validate: Whether to validate the ID before returning
//
// Returns:
//   - The payment ID string, or empty string if not present
//   - Error if extraction fails or validation fails (when validate is true)
func ExtractPaymentIdentifier(payload x402.PaymentPayload, validate bool) (string, error) {
	ext, ok := getPaymentIdentifierExtension(payload)
	if !ok {
		return "", nil
	}

	paymentExt, err := parseExtension(ext)
	if err != nil {
		return "", err
	}

	if paymentExt.Info.ID == "" {
		return "", nil
	}

	if validate && !IsValidPaymentID(paymentExt.Info.ID) {
		return "", fmt.Errorf("invalid payment ID format")
	}

	return paymentExt.Info.ID, nil
}

// ExtractPaymentIdentifierFromBytes extracts the payment identifier from raw PaymentPayload bytes.
//
// This is useful for facilitators that receive the payload as raw bytes.
// Returns empty string for V1 payloads (which don't support extensions).
//
// Args:
//   - payloadBytes: Raw JSON bytes of the payment payload
//   - validate: Whether to validate the ID before returning
//
// Returns:
//   - The payment ID string, or empty string if not present or V1 payload
//   - Error if extraction fails
func ExtractPaymentIdentifierFromBytes(payloadBytes []byte, validate bool) (string, error) {
	// Detect version using shared utility
	version, err := types.DetectVersion(payloadBytes)
	if err != nil {
		return "", fmt.Errorf("failed to detect version: %w", err)
	}

	// V1 payloads don't have extensions
	if version == 1 {
		return "", nil
	}

	// Unmarshal as V2 payload
	var payload x402.PaymentPayload
	if err := json.Unmarshal(payloadBytes, &payload); err != nil {
		return "", fmt.Errorf("failed to unmarshal payload: %w", err)
	}

	return ExtractPaymentIdentifier(payload, validate)
}

// ExtractAndValidatePaymentIdentifier extracts and validates the payment identifier from a PaymentPayload.
//
// Args:
//   - payload: The payment payload to extract from
//
// Returns:
//   - The ID (or empty string if not present)
//   - ValidationResult with any errors
func ExtractAndValidatePaymentIdentifier(payload x402.PaymentPayload) (string, ValidationResult) {
	ext, ok := getPaymentIdentifierExtension(payload)
	if !ok {
		return "", ValidationResult{Valid: true}
	}

	validation := ValidatePaymentIdentifier(ext)
	if !validation.Valid {
		return "", validation
	}

	paymentExt, err := parseExtension(ext)
	if err != nil {
		return "", ValidationResult{
			Valid:  false,
			Errors: []string{err.Error()},
		}
	}

	return paymentExt.Info.ID, ValidationResult{Valid: true}
}

// HasPaymentIdentifier checks if a PaymentPayload contains a payment-identifier extension.
//
// Args:
//   - payload: The payment payload to check
//
// Returns:
//   - True if the extension is present
func HasPaymentIdentifier(payload x402.PaymentPayload) bool {
	_, ok := getPaymentIdentifierExtension(payload)
	return ok
}

// IsPaymentIdentifierRequired checks if the server requires a payment identifier
// based on the extension info.
//
// Args:
//   - extension: The payment-identifier extension from PaymentRequired or PaymentPayload
//
// Returns:
//   - True if the server requires a payment identifier
func IsPaymentIdentifierRequired(extension interface{}) bool {
	if extension == nil {
		return false
	}

	ext, err := parseExtension(extension)
	if err != nil {
		return false
	}

	return ext.Info.Required
}

// ValidatePaymentIdentifierRequirement validates that a payment identifier is provided when required.
//
// Use this to check if a client's PaymentPayload satisfies the server's requirement.
//
// Args:
//   - payload: The client's payment payload
//   - serverRequired: Whether the server requires a payment identifier (from PaymentRequired)
//
// Returns:
//   - ValidationResult - invalid if required but not provided
func ValidatePaymentIdentifierRequirement(payload x402.PaymentPayload, serverRequired bool) ValidationResult {
	if !serverRequired {
		return ValidationResult{Valid: true}
	}

	id, err := ExtractPaymentIdentifier(payload, false)
	if err != nil {
		return ValidationResult{
			Valid:  false,
			Errors: []string{fmt.Sprintf("Failed to extract payment identifier: %v", err)},
		}
	}

	if id == "" {
		return ValidationResult{
			Valid:  false,
			Errors: []string{"Server requires a payment identifier but none was provided"},
		}
	}

	// Validate the ID format
	if !IsValidPaymentID(id) {
		return ValidationResult{
			Valid: false,
			Errors: []string{
				fmt.Sprintf("Invalid payment ID format. ID must be %d-%d characters and contain only alphanumeric characters, hyphens, and underscores.",
					PAYMENT_ID_MIN_LENGTH, PAYMENT_ID_MAX_LENGTH),
			},
		}
	}

	return ValidationResult{Valid: true}
}

// ExtractPaymentIdentifierFromPaymentRequired extracts the required flag from a PaymentRequired response.
//
// This is useful for clients to determine if they need to provide a payment identifier.
//
// Args:
//   - paymentRequiredBytes: Raw JSON bytes of the 402 PaymentRequired response
//
// Returns:
//   - Whether the server requires a payment identifier
//   - Error if extraction fails
func ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes []byte) (bool, error) {
	// Detect version using shared utility
	version, err := types.DetectVersion(paymentRequiredBytes)
	if err != nil {
		return false, fmt.Errorf("failed to detect version: %w", err)
	}

	// V1 doesn't support extensions
	if version == 1 {
		return false, nil
	}

	// V2: Extract from PaymentRequired.extensions
	var paymentRequired struct {
		Extensions map[string]interface{} `json:"extensions"`
	}
	if err := json.Unmarshal(paymentRequiredBytes, &paymentRequired); err != nil {
		return false, fmt.Errorf("failed to unmarshal payment required: %w", err)
	}

	if paymentRequired.Extensions == nil {
		return false, nil
	}

	ext, ok := paymentRequired.Extensions[PAYMENT_IDENTIFIER]
	if !ok {
		return false, nil
	}

	return IsPaymentIdentifierRequired(ext), nil
}
