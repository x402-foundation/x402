package paymentidentifier

import (
	"github.com/x402-foundation/x402/go/extensions/types"
)

// PaymentIdentifierSchema returns the JSON Schema for validating payment identifier info.
// The schema is compliant with JSON Schema Draft 2020-12.
func PaymentIdentifierSchema() types.JSONSchema {
	return types.JSONSchema{
		"$schema": "https://json-schema.org/draft/2020-12/schema",
		"type":    "object",
		"properties": map[string]interface{}{
			"required": map[string]interface{}{
				"type": "boolean",
			},
			"id": map[string]interface{}{
				"type":      "string",
				"minLength": PAYMENT_ID_MIN_LENGTH,
				"maxLength": PAYMENT_ID_MAX_LENGTH,
				"pattern":   "^[a-zA-Z0-9_-]+$",
			},
		},
		"required": []string{"required"},
	}
}
