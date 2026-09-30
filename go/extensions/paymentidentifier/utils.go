package paymentidentifier

import (
	"strings"

	"github.com/google/uuid"
)

// GeneratePaymentID generates a unique payment identifier with the given prefix.
// If prefix is empty, "pay_" is used as the default prefix.
//
// The generated ID format is: prefix + UUID v4 without hyphens (32 hex chars)
// Example: "pay_7d5d747be160e280504c099d984bcfe0"
func GeneratePaymentID(prefix string) string {
	if prefix == "" {
		prefix = "pay_"
	}
	// Generate UUID v4 without hyphens
	uuidStr := strings.ReplaceAll(uuid.New().String(), "-", "")
	return prefix + uuidStr
}

// IsValidPaymentID validates that a payment ID meets the format requirements.
// Returns true if the ID is valid, false otherwise.
//
// Validation rules:
//   - Length must be between 16 and 128 characters (inclusive)
//   - Must contain only alphanumeric characters, hyphens, and underscores
func IsValidPaymentID(id string) bool {
	if len(id) < PAYMENT_ID_MIN_LENGTH || len(id) > PAYMENT_ID_MAX_LENGTH {
		return false
	}
	return PAYMENT_ID_PATTERN.MatchString(id)
}
