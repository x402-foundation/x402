package paymentidentifier

import (
	"encoding/json"
	"fmt"
)

// AppendPaymentIdentifierToExtensions appends a payment identifier to the extensions object
// if the server declared support for the payment-identifier extension.
//
// This function reads the server's `payment-identifier` declaration from the extensions,
// and appends the client's ID to it. If the extension is not present (server didn't declare it),
// the extensions are returned unchanged.
//
// Args:
//   - extensions: The extensions object from PaymentRequired (will be modified in place)
//   - id: Optional custom payment ID. If empty, a new ID will be generated.
//
// Returns:
//   - Error if the provided ID is invalid
//
// Example:
//
//	// Get extensions from server's PaymentRequired response
//	extensions := paymentRequired.Extensions
//	if extensions == nil {
//	    extensions = make(map[string]interface{})
//	}
//
//	// Append a generated ID (only if server declared payment-identifier)
//	err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, "")
//
//	// Or use a custom ID
//	err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, "pay_my_custom_id_12345")
func AppendPaymentIdentifierToExtensions(extensions map[string]interface{}, id string) error {
	if extensions == nil {
		return nil
	}

	ext, ok := extensions[PAYMENT_IDENTIFIER]
	if !ok {
		return nil
	}

	// Only append if the server declared this extension with valid structure
	if !IsPaymentIdentifierExtension(ext) {
		return nil
	}

	// Generate ID if not provided
	paymentID := id
	if paymentID == "" {
		paymentID = GeneratePaymentID("")
	}

	// Validate the ID
	if !IsValidPaymentID(paymentID) {
		return fmt.Errorf(
			"invalid payment ID: %q. ID must be %d-%d characters and contain only alphanumeric characters, hyphens, and underscores",
			paymentID, PAYMENT_ID_MIN_LENGTH, PAYMENT_ID_MAX_LENGTH,
		)
	}

	// We need to update the info.id field in the extension
	// First, convert to our type to modify it
	extBytes, err := json.Marshal(ext)
	if err != nil {
		return fmt.Errorf("failed to marshal extension: %w", err)
	}

	var paymentExt PaymentIdentifierExtension
	if err := json.Unmarshal(extBytes, &paymentExt); err != nil {
		return fmt.Errorf("failed to unmarshal extension: %w", err)
	}

	// Add the ID
	paymentExt.Info.ID = paymentID

	// Put it back in the extensions map
	extensions[PAYMENT_IDENTIFIER] = paymentExt

	return nil
}
