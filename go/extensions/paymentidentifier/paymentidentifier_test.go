package paymentidentifier_test

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	x402 "github.com/x402-foundation/x402/go"
	"github.com/x402-foundation/x402/go/extensions/paymentidentifier"
	"github.com/x402-foundation/x402/go/extensions/types"
)

func TestConstants(t *testing.T) {
	t.Run("should have correct constant values matching TypeScript", func(t *testing.T) {
		assert.Equal(t, "payment-identifier", paymentidentifier.PAYMENT_IDENTIFIER)
		assert.Equal(t, 16, paymentidentifier.PAYMENT_ID_MIN_LENGTH)
		assert.Equal(t, 128, paymentidentifier.PAYMENT_ID_MAX_LENGTH)
	})

	t.Run("should match constants from shared types", func(t *testing.T) {
		assert.Equal(t, types.PAYMENT_IDENTIFIER, paymentidentifier.PAYMENT_IDENTIFIER)
		assert.Equal(t, types.PAYMENT_ID_MIN_LENGTH, paymentidentifier.PAYMENT_ID_MIN_LENGTH)
		assert.Equal(t, types.PAYMENT_ID_MAX_LENGTH, paymentidentifier.PAYMENT_ID_MAX_LENGTH)
	})
}

func TestGeneratePaymentID(t *testing.T) {
	t.Run("should generate ID with default prefix", func(t *testing.T) {
		id := paymentidentifier.GeneratePaymentID("")
		assert.True(t, strings.HasPrefix(id, "pay_"), "ID should start with 'pay_'")
		// pay_ (4 chars) + UUID without hyphens (32 chars) = 36 chars
		assert.Equal(t, 36, len(id), "ID should be 36 characters long")
	})

	t.Run("should generate ID with custom prefix", func(t *testing.T) {
		id := paymentidentifier.GeneratePaymentID("txn_")
		assert.True(t, strings.HasPrefix(id, "txn_"), "ID should start with 'txn_'")
		assert.Equal(t, 36, len(id), "ID should be 36 characters long")
	})

	t.Run("should generate unique IDs", func(t *testing.T) {
		id1 := paymentidentifier.GeneratePaymentID("")
		id2 := paymentidentifier.GeneratePaymentID("")
		assert.NotEqual(t, id1, id2, "Generated IDs should be unique")
	})

	t.Run("should generate valid IDs", func(t *testing.T) {
		for i := 0; i < 100; i++ {
			id := paymentidentifier.GeneratePaymentID("")
			assert.True(t, paymentidentifier.IsValidPaymentID(id), "Generated ID should be valid")
		}
	})
}

func TestIsValidPaymentID(t *testing.T) {
	t.Run("should accept valid IDs", func(t *testing.T) {
		validIDs := []string{
			"pay_1234567890123456",                 // Exactly 16 chars after prefix (20 total)
			"pay_7d5d747be160e280",                 // 20 chars
			"pay_7d5d747be160e280504c099d",         // 28 chars
			"pay_7d5d747be160e280504c099d984bcfe0", // 36 chars
			"a1b2c3d4e5f6g7h8",                     // 16 chars, alphanumeric
			strings.Repeat("a", 16),                // Minimum length
			strings.Repeat("a", 128),               // Maximum length
			"abc-def-123_456-789",                  // With hyphens and underscores
			"ABC123def456_-ab",                     // 16 chars, mixed case with special chars
		}

		for _, id := range validIDs {
			assert.True(t, paymentidentifier.IsValidPaymentID(id), "Expected %q to be valid", id)
		}
	})

	t.Run("should reject invalid IDs", func(t *testing.T) {
		invalidIDs := []string{
			"",                       // Empty
			"abc",                    // Too short (3 chars)
			"abc123",                 // Too short (6 chars)
			strings.Repeat("a", 15),  // One char below minimum
			strings.Repeat("a", 129), // One char above maximum
			"pay_abc!@#$%^&*()",      // Invalid characters
			"pay id with spaces",     // Spaces not allowed
			"pay.id.with.dots",       // Dots not allowed
			"pay+id+with+plus",       // Plus not allowed
		}

		for _, id := range invalidIDs {
			assert.False(t, paymentidentifier.IsValidPaymentID(id), "Expected %q to be invalid", id)
		}
	})
}

func TestPaymentIdentifierSchema(t *testing.T) {
	t.Run("should return valid JSON schema", func(t *testing.T) {
		schema := paymentidentifier.PaymentIdentifierSchema()

		assert.Equal(t, "https://json-schema.org/draft/2020-12/schema", schema["$schema"])
		assert.Equal(t, "object", schema["type"])

		properties, ok := schema["properties"].(map[string]interface{})
		require.True(t, ok, "Schema should have properties")

		requiredProp, ok := properties["required"].(map[string]interface{})
		require.True(t, ok, "Schema should have 'required' property")
		assert.Equal(t, "boolean", requiredProp["type"])

		idProp, ok := properties["id"].(map[string]interface{})
		require.True(t, ok, "Schema should have 'id' property")
		assert.Equal(t, "string", idProp["type"])
		assert.Equal(t, paymentidentifier.PAYMENT_ID_MIN_LENGTH, idProp["minLength"])
		assert.Equal(t, paymentidentifier.PAYMENT_ID_MAX_LENGTH, idProp["maxLength"])
		assert.Equal(t, "^[a-zA-Z0-9_-]+$", idProp["pattern"])

		requiredFields, ok := schema["required"].([]string)
		require.True(t, ok, "Schema should have required array")
		assert.Contains(t, requiredFields, "required")
	})
}

func TestDeclarePaymentIdentifierExtension(t *testing.T) {
	t.Run("should create extension with required=false", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(false)

		assert.False(t, ext.Info.Required)
		assert.Empty(t, ext.Info.ID)
		assert.NotNil(t, ext.Schema)
	})

	t.Run("should create extension with required=true", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(true)

		assert.True(t, ext.Info.Required)
		assert.Empty(t, ext.Info.ID)
		assert.NotNil(t, ext.Schema)
	})

	t.Run("should serialize to JSON correctly", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(true)

		jsonBytes, err := json.Marshal(ext)
		require.NoError(t, err)

		var parsed map[string]interface{}
		err = json.Unmarshal(jsonBytes, &parsed)
		require.NoError(t, err)

		info, ok := parsed["info"].(map[string]interface{})
		require.True(t, ok)
		assert.Equal(t, true, info["required"])

		schema, ok := parsed["schema"].(map[string]interface{})
		require.True(t, ok)
		assert.NotNil(t, schema)
	})
}

func TestAppendPaymentIdentifierToExtensions(t *testing.T) {
	t.Run("should append generated ID when extension is declared", func(t *testing.T) {
		extensions := map[string]interface{}{
			paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(true),
		}

		err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, "")
		require.NoError(t, err)

		ext, ok := extensions[paymentidentifier.PAYMENT_IDENTIFIER].(paymentidentifier.PaymentIdentifierExtension)
		require.True(t, ok)
		assert.NotEmpty(t, ext.Info.ID)
		assert.True(t, paymentidentifier.IsValidPaymentID(ext.Info.ID))
	})

	t.Run("should append custom ID when provided", func(t *testing.T) {
		extensions := map[string]interface{}{
			paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(false),
		}

		customID := "pay_custom_id_123456"
		err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, customID)
		require.NoError(t, err)

		ext, ok := extensions[paymentidentifier.PAYMENT_IDENTIFIER].(paymentidentifier.PaymentIdentifierExtension)
		require.True(t, ok)
		assert.Equal(t, customID, ext.Info.ID)
	})

	t.Run("should return error for invalid custom ID", func(t *testing.T) {
		extensions := map[string]interface{}{
			paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(true),
		}

		err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, "too_short")
		assert.Error(t, err)
		assert.Contains(t, err.Error(), "invalid payment ID")
	})

	t.Run("should not modify extensions when extension not declared", func(t *testing.T) {
		extensions := map[string]interface{}{
			"other-extension": "value",
		}

		err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, "pay_valid_id_123456")
		require.NoError(t, err)

		_, ok := extensions[paymentidentifier.PAYMENT_IDENTIFIER]
		assert.False(t, ok, "Should not add extension when not declared")
	})

	t.Run("should handle nil extensions gracefully", func(t *testing.T) {
		err := paymentidentifier.AppendPaymentIdentifierToExtensions(nil, "")
		require.NoError(t, err)
	})

	t.Run("should skip when extension has invalid structure", func(t *testing.T) {
		extensions := map[string]interface{}{
			paymentidentifier.PAYMENT_IDENTIFIER: "not-a-valid-extension",
		}

		err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, "pay_valid_id_123456")
		require.NoError(t, err)
		// Extension value should be unchanged since it's not a valid extension structure
		assert.Equal(t, "not-a-valid-extension", extensions[paymentidentifier.PAYMENT_IDENTIFIER])
	})
}

func TestIsPaymentIdentifierExtension(t *testing.T) {
	t.Run("should return true for valid extension", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(true)
		assert.True(t, paymentidentifier.IsPaymentIdentifierExtension(ext))
	})

	t.Run("should return true for extension from JSON", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(false)
		jsonBytes, _ := json.Marshal(ext)

		var parsed interface{}
		_ = json.Unmarshal(jsonBytes, &parsed)

		assert.True(t, paymentidentifier.IsPaymentIdentifierExtension(parsed))
	})

	t.Run("should return false for nil", func(t *testing.T) {
		assert.False(t, paymentidentifier.IsPaymentIdentifierExtension(nil))
	})

	t.Run("should return false for invalid structures", func(t *testing.T) {
		assert.False(t, paymentidentifier.IsPaymentIdentifierExtension("string"))
		assert.False(t, paymentidentifier.IsPaymentIdentifierExtension(123))
		assert.False(t, paymentidentifier.IsPaymentIdentifierExtension(map[string]interface{}{}))
	})
}

func TestValidatePaymentIdentifier(t *testing.T) {
	t.Run("should validate correct extension", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(true)
		result := paymentidentifier.ValidatePaymentIdentifier(ext)
		assert.True(t, result.Valid)
		assert.Empty(t, result.Errors)
	})

	t.Run("should validate extension with valid ID", func(t *testing.T) {
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       "pay_valid_id_1234567",
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}
		result := paymentidentifier.ValidatePaymentIdentifier(ext)
		assert.True(t, result.Valid)
	})

	t.Run("should reject extension with invalid ID", func(t *testing.T) {
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       "too_short",
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}
		result := paymentidentifier.ValidatePaymentIdentifier(ext)
		assert.False(t, result.Valid)
		assert.NotEmpty(t, result.Errors)
	})

	t.Run("should reject nil extension", func(t *testing.T) {
		result := paymentidentifier.ValidatePaymentIdentifier(nil)
		assert.False(t, result.Valid)
	})
}

func TestExtractPaymentIdentifier(t *testing.T) {
	t.Run("should extract ID from valid payload", func(t *testing.T) {
		testID := "pay_test_id_12345678"
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       testID,
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted: x402.PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:8453",
			},
			Payload: map[string]interface{}{},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		id, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
		require.NoError(t, err)
		assert.Equal(t, testID, id)
	})

	t.Run("should return empty string when no extensions", func(t *testing.T) {
		payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted: x402.PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:8453",
			},
			Payload: map[string]interface{}{},
		}

		id, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
		require.NoError(t, err)
		assert.Empty(t, id)
	})

	t.Run("should return empty string when extension not present", func(t *testing.T) {
		payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted: x402.PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:8453",
			},
			Payload: map[string]interface{}{},
			Extensions: map[string]interface{}{
				"other-extension": map[string]interface{}{},
			},
		}

		id, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
		require.NoError(t, err)
		assert.Empty(t, id)
	})

	t.Run("should return error for invalid ID when validate=true", func(t *testing.T) {
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       "invalid",
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted: x402.PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:8453",
			},
			Payload: map[string]interface{}{},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		id, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
		assert.Error(t, err)
		assert.Empty(t, id)
	})

	t.Run("should return empty string when extension exists but ID is empty", func(t *testing.T) {
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       "",
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted: x402.PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:8453",
			},
			Payload: map[string]interface{}{},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		id, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
		require.NoError(t, err)
		assert.Empty(t, id)
	})

	t.Run("should return ID without validation when validate=false", func(t *testing.T) {
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       "short",
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted: x402.PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:8453",
			},
			Payload: map[string]interface{}{},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		id, err := paymentidentifier.ExtractPaymentIdentifier(payload, false)
		require.NoError(t, err)
		assert.Equal(t, "short", id)
	})
}

func TestExtractPaymentIdentifierFromBytes(t *testing.T) {
	t.Run("should extract ID from V2 payload bytes", func(t *testing.T) {
		testID := "pay_test_id_12345678"
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       testID,
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted: x402.PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:8453",
			},
			Payload: map[string]interface{}{},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		payloadBytes, _ := json.Marshal(payload)

		id, err := paymentidentifier.ExtractPaymentIdentifierFromBytes(payloadBytes, true)
		require.NoError(t, err)
		assert.Equal(t, testID, id)
	})

	t.Run("should return empty string for V1 payload", func(t *testing.T) {
		v1Payload := map[string]interface{}{
			"x402Version": 1,
			"scheme":      "exact",
			"network":     "eip155:8453",
			"payload":     map[string]interface{}{},
		}

		payloadBytes, _ := json.Marshal(v1Payload)

		id, err := paymentidentifier.ExtractPaymentIdentifierFromBytes(payloadBytes, true)
		require.NoError(t, err)
		assert.Empty(t, id)
	})

	t.Run("should return error for invalid JSON", func(t *testing.T) {
		id, err := paymentidentifier.ExtractPaymentIdentifierFromBytes([]byte("invalid"), true)
		assert.Error(t, err)
		assert.Empty(t, id)
	})
}

func TestExtractAndValidatePaymentIdentifier(t *testing.T) {
	t.Run("should return ID and valid result for valid extension", func(t *testing.T) {
		testID := "pay_test_id_12345678"
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       testID,
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			X402Version: 2,
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		id, result := paymentidentifier.ExtractAndValidatePaymentIdentifier(payload)
		assert.Equal(t, testID, id)
		assert.True(t, result.Valid)
	})

	t.Run("should return empty ID and valid result when no extension", func(t *testing.T) {
		payload := x402.PaymentPayload{
			X402Version: 2,
		}

		id, result := paymentidentifier.ExtractAndValidatePaymentIdentifier(payload)
		assert.Empty(t, id)
		assert.True(t, result.Valid)
	})

	t.Run("should return empty ID and valid result when extensions exist but key is missing", func(t *testing.T) {
		payload := x402.PaymentPayload{
			X402Version: 2,
			Extensions: map[string]interface{}{
				"other-extension": "value",
			},
		}

		id, result := paymentidentifier.ExtractAndValidatePaymentIdentifier(payload)
		assert.Empty(t, id)
		assert.True(t, result.Valid)
	})

	t.Run("should return invalid result for invalid ID", func(t *testing.T) {
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       "invalid",
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			X402Version: 2,
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		id, result := paymentidentifier.ExtractAndValidatePaymentIdentifier(payload)
		assert.Empty(t, id)
		assert.False(t, result.Valid)
	})
}

func TestHasPaymentIdentifier(t *testing.T) {
	t.Run("should return true when extension is present", func(t *testing.T) {
		payload := x402.PaymentPayload{
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(true),
			},
		}
		assert.True(t, paymentidentifier.HasPaymentIdentifier(payload))
	})

	t.Run("should return false when extension is not present", func(t *testing.T) {
		payload := x402.PaymentPayload{
			Extensions: map[string]interface{}{
				"other": "value",
			},
		}
		assert.False(t, paymentidentifier.HasPaymentIdentifier(payload))
	})

	t.Run("should return false when extensions is nil", func(t *testing.T) {
		payload := x402.PaymentPayload{}
		assert.False(t, paymentidentifier.HasPaymentIdentifier(payload))
	})
}

func TestIsPaymentIdentifierRequired(t *testing.T) {
	t.Run("should return true when required=true", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(true)
		assert.True(t, paymentidentifier.IsPaymentIdentifierRequired(ext))
	})

	t.Run("should return false when required=false", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(false)
		assert.False(t, paymentidentifier.IsPaymentIdentifierRequired(ext))
	})

	t.Run("should return false for nil", func(t *testing.T) {
		assert.False(t, paymentidentifier.IsPaymentIdentifierRequired(nil))
	})

	t.Run("should work with JSON-parsed extension", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(true)
		jsonBytes, _ := json.Marshal(ext)

		var parsed interface{}
		_ = json.Unmarshal(jsonBytes, &parsed)

		assert.True(t, paymentidentifier.IsPaymentIdentifierRequired(parsed))
	})
}

func TestValidatePaymentIdentifierRequirement(t *testing.T) {
	t.Run("should return valid when not required", func(t *testing.T) {
		payload := x402.PaymentPayload{}
		result := paymentidentifier.ValidatePaymentIdentifierRequirement(payload, false)
		assert.True(t, result.Valid)
	})

	t.Run("should return valid when required and ID is present", func(t *testing.T) {
		testID := "pay_test_id_12345678"
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       testID,
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		result := paymentidentifier.ValidatePaymentIdentifierRequirement(payload, true)
		assert.True(t, result.Valid)
	})

	t.Run("should return invalid when required but not provided", func(t *testing.T) {
		payload := x402.PaymentPayload{}
		result := paymentidentifier.ValidatePaymentIdentifierRequirement(payload, true)
		assert.False(t, result.Valid)
		assert.Contains(t, result.Errors[0], "requires a payment identifier")
	})

	t.Run("should return invalid when required but ID is invalid", func(t *testing.T) {
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       "invalid",
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		result := paymentidentifier.ValidatePaymentIdentifierRequirement(payload, true)
		assert.False(t, result.Valid)
	})
}

func TestExtractPaymentIdentifierFromPaymentRequired(t *testing.T) {
	t.Run("should extract required=true from V2 PaymentRequired", func(t *testing.T) {
		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/data",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
				},
			},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(true),
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		required, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes)
		require.NoError(t, err)
		assert.True(t, required)
	})

	t.Run("should extract required=false from V2 PaymentRequired", func(t *testing.T) {
		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/data",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
				},
			},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: paymentidentifier.DeclarePaymentIdentifierExtension(false),
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		required, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes)
		require.NoError(t, err)
		assert.False(t, required)
	})

	t.Run("should return false when extension not present", func(t *testing.T) {
		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/data",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
				},
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		required, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes)
		require.NoError(t, err)
		assert.False(t, required)
	})

	t.Run("should return false for V1 PaymentRequired", func(t *testing.T) {
		v1PaymentRequired := map[string]interface{}{
			"x402Version": 1,
			"accepts":     []interface{}{},
		}

		paymentRequiredBytes, _ := json.Marshal(v1PaymentRequired)

		required, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes)
		require.NoError(t, err)
		assert.False(t, required)
	})

	t.Run("should return false for V2 PaymentRequired with nil extensions", func(t *testing.T) {
		paymentRequired := map[string]interface{}{
			"x402Version": 2,
			"accepts":     []interface{}{},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		required, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes)
		require.NoError(t, err)
		assert.False(t, required)
	})

	t.Run("should return error for invalid JSON", func(t *testing.T) {
		_, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired([]byte("invalid"))
		assert.Error(t, err)
	})
}

func TestPaymentIdentifierResourceServerExtension(t *testing.T) {
	t.Run("should have correct key", func(t *testing.T) {
		assert.Equal(t, paymentidentifier.PAYMENT_IDENTIFIER, paymentidentifier.PaymentIdentifierResourceServerExtension.Key())
	})

	t.Run("should return unchanged declaration from EnrichDeclaration", func(t *testing.T) {
		ext := paymentidentifier.DeclarePaymentIdentifierExtension(true)
		enriched := paymentidentifier.PaymentIdentifierResourceServerExtension.EnrichDeclaration(ext, nil)
		assert.Equal(t, ext, enriched)
	})
}

func TestIntegration_FullWorkflow(t *testing.T) {
	t.Run("should handle complete server-to-client-to-facilitator workflow", func(t *testing.T) {
		// 1. Server declares extension
		serverExt := paymentidentifier.DeclarePaymentIdentifierExtension(true)

		// 2. Server creates PaymentRequired
		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL:         "https://api.example.com/data",
				Description: "Protected data endpoint",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
					Amount:  "1000000",
				},
			},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: serverExt,
			},
		}

		// 3. Client receives PaymentRequired (simulate JSON round-trip)
		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		var clientPaymentRequired x402.PaymentRequired
		err := json.Unmarshal(paymentRequiredBytes, &clientPaymentRequired)
		require.NoError(t, err)

		// 4. Client checks if payment identifier is required
		required, err := paymentidentifier.ExtractPaymentIdentifierFromPaymentRequired(paymentRequiredBytes)
		require.NoError(t, err)
		assert.True(t, required)

		// 5. Client creates extensions and appends payment identifier
		clientExtensions := make(map[string]interface{})
		for k, v := range clientPaymentRequired.Extensions {
			clientExtensions[k] = v
		}

		err = paymentidentifier.AppendPaymentIdentifierToExtensions(clientExtensions, "")
		require.NoError(t, err)

		// 6. Client creates PaymentPayload
		clientPayload := x402.PaymentPayload{
			X402Version: 2,
			Accepted:    clientPaymentRequired.Accepts[0],
			Payload:     map[string]interface{}{},
			Resource:    clientPaymentRequired.Resource,
			Extensions:  clientExtensions,
		}

		// 7. Facilitator receives payload (simulate JSON round-trip)
		clientPayloadBytes, _ := json.Marshal(clientPayload)

		// 8. Facilitator extracts payment identifier
		extractedID, err := paymentidentifier.ExtractPaymentIdentifierFromBytes(clientPayloadBytes, true)
		require.NoError(t, err)
		assert.NotEmpty(t, extractedID)
		assert.True(t, strings.HasPrefix(extractedID, "pay_"))

		// 9. Facilitator validates requirement
		var facilitatorPayload x402.PaymentPayload
		err = json.Unmarshal(clientPayloadBytes, &facilitatorPayload)
		require.NoError(t, err)

		result := paymentidentifier.ValidatePaymentIdentifierRequirement(facilitatorPayload, true)
		assert.True(t, result.Valid)
	})

	t.Run("should handle workflow with custom ID", func(t *testing.T) {
		customID := "custom_payment_id_12345678"

		// Server declares extension
		serverExt := paymentidentifier.DeclarePaymentIdentifierExtension(false)

		// Create extensions and append custom ID
		extensions := map[string]interface{}{
			paymentidentifier.PAYMENT_IDENTIFIER: serverExt,
		}

		err := paymentidentifier.AppendPaymentIdentifierToExtensions(extensions, customID)
		require.NoError(t, err)

		// Create payload
		payload := x402.PaymentPayload{
			X402Version: 2,
			Extensions:  extensions,
		}

		// Extract ID
		extractedID, err := paymentidentifier.ExtractPaymentIdentifier(payload, true)
		require.NoError(t, err)
		assert.Equal(t, customID, extractedID)
	})
}

func TestJSONRoundTrip(t *testing.T) {
	t.Run("should maintain consistency through marshal/unmarshal", func(t *testing.T) {
		original := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       "pay_test_id_12345678",
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		// Marshal
		jsonBytes, err := json.Marshal(original)
		require.NoError(t, err)

		// Unmarshal
		var parsed paymentidentifier.PaymentIdentifierExtension
		err = json.Unmarshal(jsonBytes, &parsed)
		require.NoError(t, err)

		// Compare
		assert.Equal(t, original.Info.Required, parsed.Info.Required)
		assert.Equal(t, original.Info.ID, parsed.Info.ID)
	})

	t.Run("should handle extension in PaymentPayload", func(t *testing.T) {
		testID := "pay_test_id_12345678"
		ext := paymentidentifier.PaymentIdentifierExtension{
			Info: paymentidentifier.PaymentIdentifierInfo{
				Required: true,
				ID:       testID,
			},
			Schema: paymentidentifier.PaymentIdentifierSchema(),
		}

		payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted: x402.PaymentRequirements{
				Scheme:  "exact",
				Network: "eip155:8453",
			},
			Payload: map[string]interface{}{},
			Extensions: map[string]interface{}{
				paymentidentifier.PAYMENT_IDENTIFIER: ext,
			},
		}

		// Marshal
		jsonBytes, err := json.Marshal(payload)
		require.NoError(t, err)

		// Unmarshal
		var parsed x402.PaymentPayload
		err = json.Unmarshal(jsonBytes, &parsed)
		require.NoError(t, err)

		// Extract ID
		extractedID, err := paymentidentifier.ExtractPaymentIdentifier(parsed, true)
		require.NoError(t, err)
		assert.Equal(t, testID, extractedID)
	})
}
