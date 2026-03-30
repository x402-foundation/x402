package bazaar_test

import (
	"encoding/json"
	"testing"

	x402 "github.com/coinbase/x402/go"
	"github.com/coinbase/x402/go/extensions/bazaar"
	v1 "github.com/coinbase/x402/go/extensions/v1"
	x402http "github.com/coinbase/x402/go/http"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBazaarConstant(t *testing.T) {
	assert.Equal(t, "bazaar", bazaar.BAZAAR.Key())
}

func TestDeclareDiscoveryExtension_GET(t *testing.T) {
	t.Run("should create a valid GET extension with query params", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{
				"query": "test",
				"limit": 10,
			},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
					"limit": map[string]interface{}{"type": "number"},
				},
				"required": []string{"query"},
			},
			"",
			nil,
		)

		require.NoError(t, err)
		assert.NotNil(t, extension.Info)
		assert.NotNil(t, extension.Schema)

		queryInput, ok := extension.Info.Input.(bazaar.QueryInput)
		require.True(t, ok, "Expected QueryInput type")
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)
		assert.Equal(t, "http", queryInput.Type)
		assert.NotNil(t, queryInput.QueryParams)
		assert.Equal(t, "test", queryInput.QueryParams["query"])
		assert.Equal(t, 10, queryInput.QueryParams["limit"])
	})

	t.Run("should create a GET extension with output example", func(t *testing.T) {
		outputExample := map[string]interface{}{
			"results": []interface{}{},
			"total":   0,
		}

		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
				},
			},
			"",
			&bazaar.OutputConfig{
				Example: outputExample,
			},
		)

		require.NoError(t, err)
		assert.NotNil(t, extension.Info.Output)
		assert.Equal(t, outputExample, extension.Info.Output.Example)
	})
}

func TestDeclareDiscoveryExtension_POST(t *testing.T) {
	t.Run("should create a valid POST extension with JSON body", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{
				"name": "John",
				"age":  30,
			},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"name": map[string]interface{}{"type": "string"},
					"age":  map[string]interface{}{"type": "number"},
				},
				"required": []string{"name"},
			},
			bazaar.BodyTypeJSON,
			nil,
		)

		require.NoError(t, err)

		bodyInput, ok := extension.Info.Input.(bazaar.BodyInput)
		require.True(t, ok, "Expected BodyInput type")
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)
		assert.Equal(t, "http", bodyInput.Type)
		assert.Equal(t, bazaar.BodyTypeJSON, bodyInput.BodyType)

		bodyMap, ok := bodyInput.Body.(map[string]interface{})
		require.True(t, ok)
		assert.Equal(t, "John", bodyMap["name"])
		assert.Equal(t, 30, bodyMap["age"])
	})

	t.Run("should default to JSON body type if not specified", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"data": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"data": map[string]interface{}{"type": "string"},
				},
			},
			"", // empty bodyType
			nil,
		)

		require.NoError(t, err)

		bodyInput, ok := extension.Info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.BodyTypeJSON, bodyInput.BodyType)
	})

	t.Run("should support form-data body type", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"file": "upload.pdf"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"file": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeFormData,
			nil,
		)

		require.NoError(t, err)

		bodyInput, ok := extension.Info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.BodyTypeFormData, bodyInput.BodyType)
	})
}

func TestDeclareDiscoveryExtension_OtherMethods(t *testing.T) {
	t.Run("should create a valid PUT extension", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPUT,
			map[string]interface{}{
				"id":   "123",
				"name": "Updated",
			},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"id":   map[string]interface{}{"type": "string"},
					"name": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)

		require.NoError(t, err)

		bodyInput, ok := extension.Info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPUT, bodyInput.Method)
	})

	t.Run("should create a valid PATCH extension", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPATCH,
			map[string]interface{}{"status": "active"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"status": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)

		require.NoError(t, err)

		bodyInput, ok := extension.Info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPATCH, bodyInput.Method)
	})

	t.Run("should create a valid DELETE extension", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodDELETE,
			map[string]interface{}{"id": "123"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"id": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)

		require.NoError(t, err)

		queryInput, ok := extension.Info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodDELETE, queryInput.Method)
	})

	t.Run("should create a valid HEAD extension", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodHEAD,
			nil,
			nil,
			"",
			nil,
		)

		require.NoError(t, err)

		queryInput, ok := extension.Info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodHEAD, queryInput.Method)
	})

	t.Run("should return error for unsupported method", func(t *testing.T) {
		_, err := bazaar.DeclareDiscoveryExtension(
			"INVALID",
			nil,
			nil,
			"",
			nil,
		)

		assert.Error(t, err)
		assert.Contains(t, err.Error(), "unsupported HTTP method")
	})
}

func TestValidateDiscoveryExtension(t *testing.T) {
	t.Run("should validate a correct GET extension", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)

		result := bazaar.ValidateDiscoveryExtension(extension)
		assert.True(t, result.Valid)
		assert.Nil(t, result.Errors)
	})

	t.Run("should validate a correct POST extension", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"name": "John"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"name": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)

		result := bazaar.ValidateDiscoveryExtension(extension)
		assert.True(t, result.Valid)
	})
}

func TestExtractDiscoveryInfoFromExtension(t *testing.T) {
	t.Run("should extract info from a valid extension", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)

		info, err := bazaar.ExtractDiscoveryInfoFromExtension(extension, true)
		require.NoError(t, err)
		require.NotNil(t, info)

		queryInput, ok := info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)
		assert.Equal(t, "http", queryInput.Type)
	})

	t.Run("should extract info without validation when validate=false", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"name": "John"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"name": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)

		info, err := bazaar.ExtractDiscoveryInfoFromExtension(extension, false)
		require.NoError(t, err)
		require.NotNil(t, info)
	})
}

func TestExtractDiscoveredResourceFromPaymentPayload_FullFlow(t *testing.T) {
	t.Run("should extract info from v2 PaymentPayload with extensions", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"userId": "123"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"userId": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)

		requirements := x402.PaymentRequirements{
			Scheme:  "exact",
			Network: "eip155:8453",
		}

		paymentPayload := x402.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     map[string]interface{}{},
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/data",
			},
			Extensions: map[string]interface{}{
				bazaar.BAZAAR.Key(): extension,
			},
		}

		// Marshal to bytes (new signature)
		payloadBytes, _ := json.Marshal(paymentPayload)
		requirementsBytes, _ := json.Marshal(requirements)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)

		bodyInput, ok := info.DiscoveryInfo.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)
		assert.Equal(t, "http", bodyInput.Type)
		assert.Equal(t, "https://api.example.com/data", info.ResourceURL)
		assert.Equal(t, 2, info.X402Version)
	})

	t.Run("should extract info from v1 PaymentRequirements", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"scheme":            "exact",
			"network":           "eip155:8453",
			"maxAmountRequired": "10000",
			"resource":          "https://api.example.com/data",
			"description":       "Get data",
			"mimeType":          "application/json",
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"type":         "http",
					"method":       "GET",
					"discoverable": true,
					"queryParams": map[string]interface{}{
						"q": "test",
					},
				},
			},
			"payTo":             "0x...",
			"maxTimeoutSeconds": 300,
			"asset":             "0x...",
		}

		v1Payload := map[string]interface{}{
			"x402Version": 1,
			"scheme":      "exact",
			"network":     "eip155:8453",
			"payload":     map[string]interface{}{},
		}

		// Marshal to bytes (new signature)
		payloadBytes, _ := json.Marshal(v1Payload)
		requirementsBytes, _ := json.Marshal(v1Requirements)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)

		queryInput, ok := info.DiscoveryInfo.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)
		assert.Equal(t, "http", queryInput.Type)
		assert.Equal(t, "https://api.example.com/data", info.ResourceURL)
		assert.Equal(t, 1, info.X402Version)
	})

	t.Run("should strip query params from v2 resourceUrl", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"city": "NYC"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"city": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)

		requirements := x402.PaymentRequirements{
			Scheme:  "exact",
			Network: "eip155:8453",
		}

		paymentPayload := x402.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     map[string]interface{}{},
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/weather?city=NYC&units=metric",
			},
			Extensions: map[string]interface{}{
				bazaar.BAZAAR.Key(): extension,
			},
		}

		payloadBytes, _ := json.Marshal(paymentPayload)
		requirementsBytes, _ := json.Marshal(requirements)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/weather", info.ResourceURL)
	})

	t.Run("should strip hash sections from v2 resourceUrl", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{},
			bazaar.JSONSchema{"properties": map[string]interface{}{}},
			"",
			nil,
		)

		requirements := x402.PaymentRequirements{
			Scheme:  "exact",
			Network: "eip155:8453",
		}

		paymentPayload := x402.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     map[string]interface{}{},
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/docs#section-1",
			},
			Extensions: map[string]interface{}{
				bazaar.BAZAAR.Key(): extension,
			},
		}

		payloadBytes, _ := json.Marshal(paymentPayload)
		requirementsBytes, _ := json.Marshal(requirements)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/docs", info.ResourceURL)
	})

	t.Run("should strip both query params and hash from v2 resourceUrl", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{},
			bazaar.JSONSchema{"properties": map[string]interface{}{}},
			"",
			nil,
		)

		requirements := x402.PaymentRequirements{
			Scheme:  "exact",
			Network: "eip155:8453",
		}

		paymentPayload := x402.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     map[string]interface{}{},
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/page?foo=bar#anchor",
			},
			Extensions: map[string]interface{}{
				bazaar.BAZAAR.Key(): extension,
			},
		}

		payloadBytes, _ := json.Marshal(paymentPayload)
		requirementsBytes, _ := json.Marshal(requirements)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/page", info.ResourceURL)
	})

	t.Run("should strip query params from v1 resourceUrl", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"scheme":            "exact",
			"network":           "eip155:8453",
			"maxAmountRequired": "10000",
			"resource":          "https://api.example.com/search?q=test&page=1",
			"description":       "Search",
			"mimeType":          "application/json",
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"type":         "http",
					"method":       "GET",
					"discoverable": true,
					"queryParams": map[string]interface{}{
						"q":    "string",
						"page": "number",
					},
				},
			},
			"payTo":             "0x...",
			"maxTimeoutSeconds": 300,
			"asset":             "0x...",
		}

		v1Payload := map[string]interface{}{
			"x402Version": 1,
			"scheme":      "exact",
			"network":     "eip155:8453",
			"payload":     map[string]interface{}{},
		}

		payloadBytes, _ := json.Marshal(v1Payload)
		requirementsBytes, _ := json.Marshal(v1Requirements)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/search", info.ResourceURL)
	})

	t.Run("should strip hash sections from v1 resourceUrl", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"scheme":            "exact",
			"network":           "eip155:8453",
			"maxAmountRequired": "10000",
			"resource":          "https://api.example.com/docs#section",
			"description":       "Docs",
			"mimeType":          "application/json",
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"type":         "http",
					"method":       "GET",
					"discoverable": true,
				},
			},
			"payTo":             "0x...",
			"maxTimeoutSeconds": 300,
			"asset":             "0x...",
		}

		v1Payload := map[string]interface{}{
			"x402Version": 1,
			"scheme":      "exact",
			"network":     "eip155:8453",
			"payload":     map[string]interface{}{},
		}

		payloadBytes, _ := json.Marshal(v1Payload)
		requirementsBytes, _ := json.Marshal(v1Requirements)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/docs", info.ResourceURL)
	})

	t.Run("should return nil when no discovery info is present", func(t *testing.T) {
		requirements := x402.PaymentRequirements{
			Scheme:  "exact",
			Network: "eip155:8453",
		}

		paymentPayload := x402.PaymentPayload{
			X402Version: 2,
			Accepted:    requirements,
			Payload:     map[string]interface{}{},
		}

		// Marshal to bytes (new signature)
		payloadBytes, _ := json.Marshal(paymentPayload)
		requirementsBytes, _ := json.Marshal(requirements)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		assert.Nil(t, info)
	})

	t.Run("should return error for invalid json", func(t *testing.T) {
		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload([]byte("invalid"), []byte("{}"), true)
		require.Error(t, err)
		assert.Nil(t, info)
		assert.Contains(t, err.Error(), "failed to parse version")
	})

	t.Run("should return error for unsupported version", func(t *testing.T) {
		payload := map[string]interface{}{
			"x402Version": 99,
		}
		payloadBytes, _ := json.Marshal(payload)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, []byte("{}"), true)
		require.Error(t, err)
		assert.Nil(t, info)
		assert.Contains(t, err.Error(), "unsupported version")
	})
}

func TestValidateAndExtract(t *testing.T) {
	t.Run("should return valid result with info for correct extension", func(t *testing.T) {
		extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)

		result := bazaar.ValidateAndExtract(extension)
		assert.True(t, result.Valid)
		assert.NotNil(t, result.Info)
		assert.Nil(t, result.Errors)
	})
}

func TestV1Transformation(t *testing.T) {
	t.Run("should extract discovery info from v1 GET with no params", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"type":         "http",
					"method":       "GET",
					"discoverable": true,
				},
				"output": nil,
			},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		require.NotNil(t, info)

		queryInput, ok := info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)
		assert.Equal(t, "http", queryInput.Type)
	})

	t.Run("should extract discovery info from v1 GET with queryParams", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"discoverable": true,
					"method":       "GET",
					"queryParams": map[string]interface{}{
						"limit":  "integer parameter",
						"offset": "integer parameter",
					},
					"type": "http",
				},
				"output": map[string]interface{}{"type": "array"},
			},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		require.NotNil(t, info)

		queryInput, ok := info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)
		assert.Equal(t, "integer parameter", queryInput.QueryParams["limit"])
		assert.Equal(t, "integer parameter", queryInput.QueryParams["offset"])
	})

	t.Run("should extract discovery info from v1 POST with bodyFields", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"bodyFields": map[string]interface{}{
						"query": map[string]interface{}{
							"description": "Search query",
							"required":    true,
							"type":        "string",
						},
					},
					"bodyType":     "json",
					"discoverable": true,
					"method":       "POST",
					"type":         "http",
				},
			},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		require.NotNil(t, info)

		bodyInput, ok := info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)
		assert.Equal(t, bazaar.BodyTypeJSON, bodyInput.BodyType)

		bodyMap, ok := bodyInput.Body.(map[string]interface{})
		require.True(t, ok)
		assert.NotNil(t, bodyMap["query"])
	})

	t.Run("should extract discovery info from v1 POST with snake_case fields", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"body_fields":  nil,
					"body_type":    nil,
					"discoverable": true,
					"header_fields": map[string]interface{}{
						"X-Budget": map[string]interface{}{
							"description": "Budget",
							"required":    false,
							"type":        "string",
						},
					},
					"method":       "POST",
					"query_params": nil,
					"type":         "http",
				},
				"output": nil,
			},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		require.NotNil(t, info)

		bodyInput, ok := info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)
		assert.NotNil(t, bodyInput.Headers)
	})

	t.Run("should extract discovery info from v1 POST with bodyParams", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"bodyParams": map[string]interface{}{
						"question": map[string]interface{}{
							"description": "Question",
							"required":    true,
							"type":        "string",
							"maxLength":   500,
						},
					},
					"discoverable": true,
					"method":       "POST",
					"type":         "http",
				},
			},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		require.NotNil(t, info)

		bodyInput, ok := info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)

		bodyMap, ok := bodyInput.Body.(map[string]interface{})
		require.True(t, ok)
		assert.NotNil(t, bodyMap["question"])
	})

	t.Run("should extract discovery info from v1 POST with properties field", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"discoverable": true,
					"method":       "POST",
					"properties": map[string]interface{}{
						"message": map[string]interface{}{
							"description": "Message",
							"type":        "string",
						},
						"stream": map[string]interface{}{
							"description": "Stream",
							"type":        "boolean",
						},
					},
					"required": []string{"message"},
					"type":     "http",
				},
			},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		require.NotNil(t, info)

		bodyInput, ok := info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)

		bodyMap, ok := bodyInput.Body.(map[string]interface{})
		require.True(t, ok)
		assert.NotNil(t, bodyMap["message"])
		assert.NotNil(t, bodyMap["stream"])
	})

	t.Run("should handle v1 POST with no body content (minimal)", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"discoverable": true,
					"method":       "POST",
					"type":         "http",
				},
			},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		require.NotNil(t, info)

		bodyInput, ok := info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)
		assert.Equal(t, bazaar.BodyTypeJSON, bodyInput.BodyType)

		bodyMap, ok := bodyInput.Body.(map[string]interface{})
		require.True(t, ok)
		assert.Empty(t, bodyMap)
	})

	t.Run("should skip non-discoverable endpoints", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"discoverable": false,
					"method":       "POST",
					"type":         "http",
				},
			},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		assert.Nil(t, info)
	})

	t.Run("should handle missing outputSchema", func(t *testing.T) {
		v1Requirements := map[string]interface{}{
			"outputSchema": map[string]interface{}{},
		}

		info, err := v1.ExtractDiscoveryInfoV1(v1Requirements)
		require.NoError(t, err)
		assert.Nil(t, info)
	})
}

func TestIntegration_FullWorkflow(t *testing.T) {
	t.Run("should handle GET endpoint with output schema (e2e scenario)", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{},
			},
			"",
			&bazaar.OutputConfig{
				Example: map[string]interface{}{
					"message":   "Protected endpoint accessed successfully",
					"timestamp": "2024-01-01T00:00:00Z",
				},
				Schema: bazaar.JSONSchema{
					"properties": map[string]interface{}{
						"message":   map[string]interface{}{"type": "string"},
						"timestamp": map[string]interface{}{"type": "string"},
					},
					"required": []string{"message", "timestamp"},
				},
			},
		)

		require.NoError(t, err)

		// Validate the extension
		validation := bazaar.ValidateDiscoveryExtension(extension)
		assert.True(t, validation.Valid, "Extension should be valid")

		// Extract info
		info, err := bazaar.ExtractDiscoveryInfoFromExtension(extension, false)
		require.NoError(t, err)

		queryInput, ok := info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)

		outputExample, ok := info.Output.Example.(map[string]interface{})
		require.True(t, ok)
		assert.Equal(t, "Protected endpoint accessed successfully", outputExample["message"])
		assert.Equal(t, "2024-01-01T00:00:00Z", outputExample["timestamp"])
	})

	t.Run("should handle complete v2 server-to-facilitator workflow", func(t *testing.T) {
		// 1. Server declares extension
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{
				"userId": "123",
				"action": "create",
			},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"userId": map[string]interface{}{"type": "string"},
					"action": map[string]interface{}{
						"type": "string",
						"enum": []string{"create", "update", "delete"},
					},
				},
				"required": []string{"userId", "action"},
			},
			bazaar.BodyTypeJSON,
			&bazaar.OutputConfig{
				Example: map[string]interface{}{
					"success": true,
					"id":      "new-id",
				},
			},
		)

		require.NoError(t, err)

		// 2. Server includes in PaymentRequired (simulate JSON round-trip)
		paymentRequiredJSON, _ := json.Marshal(map[string]interface{}{
			"x402Version": 2,
			"resource": map[string]interface{}{
				"url":         "/api/action",
				"description": "Execute an action",
				"mimeType":    "application/json",
			},
			"accepts": []interface{}{},
			"extensions": map[string]interface{}{
				bazaar.BAZAAR.Key(): extension,
			},
		})

		var paymentRequired map[string]interface{}
		_ = json.Unmarshal(paymentRequiredJSON, &paymentRequired)

		// 3. Facilitator receives and validates
		bazaarExtRaw := paymentRequired["extensions"].(map[string]interface{})[bazaar.BAZAAR.Key()]
		bazaarExtJSON, _ := json.Marshal(bazaarExtRaw)
		var bazaarExt bazaar.DiscoveryExtension
		_ = json.Unmarshal(bazaarExtJSON, &bazaarExt)

		validation := bazaar.ValidateDiscoveryExtension(bazaarExt)
		assert.True(t, validation.Valid)

		// 4. Facilitator extracts info for cataloging
		info, err := bazaar.ExtractDiscoveryInfoFromExtension(bazaarExt, false)
		require.NoError(t, err)

		bodyInput, ok := info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)
		assert.Equal(t, bazaar.BodyTypeJSON, bodyInput.BodyType)

		bodyMap, ok := bodyInput.Body.(map[string]interface{})
		require.True(t, ok)
		assert.Equal(t, "123", bodyMap["userId"])
		assert.Equal(t, "create", bodyMap["action"])

		outputExample, ok := info.Output.Example.(map[string]interface{})
		require.True(t, ok)
		assert.Equal(t, true, outputExample["success"])
		assert.Equal(t, "new-id", outputExample["id"])
	})

	t.Run("should handle v1-to-v2 transformation workflow", func(t *testing.T) {
		// V1 PaymentRequirements from real Bazaar data
		v1Requirements := map[string]interface{}{
			"scheme":            "exact",
			"network":           "eip155:8453",
			"maxAmountRequired": "10000",
			"resource":          "https://mesh.heurist.xyz/x402/agents/TokenResolverAgent/search",
			"description":       "Find tokens by address, ticker/symbol, or token name",
			"mimeType":          "application/json",
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"bodyFields": map[string]interface{}{
						"chain": map[string]interface{}{
							"description": "Optional chain hint",
							"type":        "string",
						},
						"query": map[string]interface{}{
							"description": "Token search query",
							"required":    true,
							"type":        "string",
						},
						"type_hint": map[string]interface{}{
							"description": "Optional type hint",
							"enum":        []string{"address", "symbol", "name"},
							"type":        "string",
						},
					},
					"bodyType":     "json",
					"discoverable": true,
					"method":       "POST",
					"type":         "http",
				},
			},
			"payTo":             "0x7d9d1821d15B9e0b8Ab98A058361233E255E405D",
			"maxTimeoutSeconds": 120,
			"asset":             "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
			"extra":             map[string]interface{}{},
		}

		v1Payload := map[string]interface{}{
			"x402Version": 1,
			"scheme":      "exact",
			"network":     "eip155:8453",
			"payload":     map[string]interface{}{},
		}

		// Marshal to bytes (new signature)
		payloadBytes, _ := json.Marshal(v1Payload)
		requirementsBytes, _ := json.Marshal(v1Requirements)

		// Facilitator extracts v1 info and transforms to v2
		info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadBytes, requirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)

		bodyInput, ok := info.DiscoveryInfo.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)
		assert.Equal(t, "http", bodyInput.Type)
		assert.Equal(t, bazaar.BodyTypeJSON, bodyInput.BodyType)

		bodyMap, ok := bodyInput.Body.(map[string]interface{})
		require.True(t, ok)
		assert.NotNil(t, bodyMap["query"])
		assert.NotNil(t, bodyMap["chain"])
		assert.NotNil(t, bodyMap["type_hint"])

		// Verify resource URL extracted correctly
		assert.Equal(t, "https://mesh.heurist.xyz/x402/agents/TokenResolverAgent/search", info.ResourceURL)
		assert.Equal(t, "Find tokens by address, ticker/symbol, or token name", info.Description)
		assert.Equal(t, "application/json", info.MimeType)
		assert.Equal(t, 1, info.X402Version)
	})

	t.Run("should handle unified extraction for both v1 and v2", func(t *testing.T) {
		// V2 case - extensions are in PaymentPayload
		v2Extension, _ := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"limit": 10},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"limit": map[string]interface{}{"type": "number"},
				},
			},
			"",
			nil,
		)

		v2Requirements := x402.PaymentRequirements{
			Scheme:  "exact",
			Network: "eip155:8453",
		}

		v2Payload := x402.PaymentPayload{
			X402Version: 2,
			Accepted:    v2Requirements,
			Payload:     map[string]interface{}{},
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/items",
			},
			Extensions: map[string]interface{}{
				bazaar.BAZAAR.Key(): v2Extension,
			},
		}

		// Marshal to bytes (new signature)
		v2PayloadBytes, _ := json.Marshal(v2Payload)
		v2RequirementsBytes, _ := json.Marshal(v2Requirements)

		v2Info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(v2PayloadBytes, v2RequirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, v2Info)

		queryInput, ok := v2Info.DiscoveryInfo.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)
		assert.Equal(t, 2, v2Info.X402Version)

		// V1 case - discovery info is in PaymentRequirements.outputSchema
		v1Requirements := map[string]interface{}{
			"resource": "https://api.example.com/search",
			"outputSchema": map[string]interface{}{
				"input": map[string]interface{}{
					"discoverable": true,
					"method":       "GET",
					"queryParams":  map[string]interface{}{"limit": "number"},
					"type":         "http",
				},
			},
		}

		v1Payload := map[string]interface{}{
			"x402Version": 1,
			"scheme":      "exact",
			"network":     "eip155:8453",
			"payload":     map[string]interface{}{},
		}

		// Marshal to bytes (new signature)
		v1PayloadBytes, _ := json.Marshal(v1Payload)
		v1RequirementsBytes, _ := json.Marshal(v1Requirements)

		v1Info, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(v1PayloadBytes, v1RequirementsBytes, true)
		require.NoError(t, err)
		require.NotNil(t, v1Info)

		queryInput2, ok := v1Info.DiscoveryInfo.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput2.Method)
		assert.Equal(t, 1, v1Info.X402Version)

		// Both v1 and v2 return the same DiscoveryInfo structure
		assert.IsType(t, v2Info.DiscoveryInfo.Input, v1Info.DiscoveryInfo.Input)
	})
}

func TestExtractDiscoveredResourceFromPaymentRequired(t *testing.T) {
	t.Run("v2: should extract discovery info from PaymentRequired.extensions", func(t *testing.T) {
		// Create a v2 discovery extension
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)
		require.NoError(t, err)

		// Create a v2 PaymentRequired with extensions
		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL:         "https://api.example.com/data",
				Description: "Test resource",
				MimeType:    "application/json",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
					Amount:  "1000000",
				},
			},
			Extensions: map[string]interface{}{
				"bazaar": extension,
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)

		assert.Equal(t, "https://api.example.com/data", info.ResourceURL)
		assert.Equal(t, 2, info.X402Version)
		assert.Equal(t, "GET", info.Method)

		queryInput, ok := info.DiscoveryInfo.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)
	})

	t.Run("v2: should return nil when no discovery info is present", func(t *testing.T) {
		// Create a v2 PaymentRequired without extensions
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

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		assert.Nil(t, info)
	})

	t.Run("v2: should extract discovery info with POST body", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"name": "John", "age": 30},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"name": map[string]interface{}{"type": "string"},
					"age":  map[string]interface{}{"type": "number"},
				},
			},
			bazaar.BodyTypeJSON,
			&bazaar.OutputConfig{
				Example: map[string]interface{}{"success": true},
			},
		)
		require.NoError(t, err)

		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/users",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
				},
			},
			Extensions: map[string]interface{}{
				"bazaar": extension,
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)

		assert.Equal(t, "POST", info.Method)
		bodyInput, ok := info.DiscoveryInfo.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.BodyTypeJSON, bodyInput.BodyType)
	})

	t.Run("v2: should strip query params from resourceUrl", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"city": "NYC"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"city": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)
		require.NoError(t, err)

		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/weather?city=NYC&units=metric",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
				},
			},
			Extensions: map[string]interface{}{
				"bazaar": extension,
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/weather", info.ResourceURL)
	})

	t.Run("v2: should strip hash sections from resourceUrl", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{},
			bazaar.JSONSchema{"properties": map[string]interface{}{}},
			"",
			nil,
		)
		require.NoError(t, err)

		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/docs#section-1",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
				},
			},
			Extensions: map[string]interface{}{
				"bazaar": extension,
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/docs", info.ResourceURL)
	})

	t.Run("v2: should strip both query params and hash from resourceUrl", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{},
			bazaar.JSONSchema{"properties": map[string]interface{}{}},
			"",
			nil,
		)
		require.NoError(t, err)

		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/page?foo=bar#anchor",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
				},
			},
			Extensions: map[string]interface{}{
				"bazaar": extension,
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/page", info.ResourceURL)
	})

	t.Run("v1: should strip query params from resourceUrl", func(t *testing.T) {
		v1PaymentRequired := map[string]interface{}{
			"x402Version": 1,
			"accepts": []interface{}{
				map[string]interface{}{
					"scheme":            "exact",
					"network":           "eip155:8453",
					"maxAmountRequired": "1000000",
					"resource":          "https://api.example.com/search?q=test&page=1",
					"payTo":             "0x123",
					"asset":             "0x456",
					"maxTimeoutSeconds": 300,
					"outputSchema": map[string]interface{}{
						"input": map[string]interface{}{
							"type":         "http",
							"method":       "GET",
							"discoverable": true,
							"queryParams": map[string]interface{}{
								"q":    "string",
								"page": "number",
							},
						},
					},
				},
			},
		}

		paymentRequiredBytes, _ := json.Marshal(v1PaymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/search", info.ResourceURL)
	})

	t.Run("v1: should strip hash sections from resourceUrl", func(t *testing.T) {
		v1PaymentRequired := map[string]interface{}{
			"x402Version": 1,
			"accepts": []interface{}{
				map[string]interface{}{
					"scheme":            "exact",
					"network":           "eip155:8453",
					"maxAmountRequired": "1000000",
					"resource":          "https://api.example.com/docs#section",
					"payTo":             "0x123",
					"asset":             "0x456",
					"maxTimeoutSeconds": 300,
					"outputSchema": map[string]interface{}{
						"input": map[string]interface{}{
							"type":         "http",
							"method":       "GET",
							"discoverable": true,
						},
					},
				},
			},
		}

		paymentRequiredBytes, _ := json.Marshal(v1PaymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "https://api.example.com/docs", info.ResourceURL)
	})

	t.Run("v1: should extract discovery info from accepts[0].outputSchema", func(t *testing.T) {
		// Create a v1 PaymentRequired with outputSchema in accepts[0]
		v1PaymentRequired := map[string]interface{}{
			"x402Version": 1,
			"accepts": []interface{}{
				map[string]interface{}{
					"scheme":            "exact",
					"network":           "eip155:8453",
					"maxAmountRequired": "1000000",
					"resource":          "https://api.example.com/data",
					"payTo":             "0x123",
					"asset":             "0x456",
					"maxTimeoutSeconds": 300,
					"outputSchema": map[string]interface{}{
						"input": map[string]interface{}{
							"type":         "http",
							"method":       "GET",
							"discoverable": true,
							"queryParams": map[string]interface{}{
								"query": "test",
							},
						},
					},
				},
			},
		}

		paymentRequiredBytes, _ := json.Marshal(v1PaymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)

		assert.Equal(t, "https://api.example.com/data", info.ResourceURL)
		assert.Equal(t, 1, info.X402Version)
		assert.Equal(t, "GET", info.Method)

		queryInput, ok := info.DiscoveryInfo.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodGET, queryInput.Method)
	})

	t.Run("v1: should return nil when accepts array is empty", func(t *testing.T) {
		v1PaymentRequired := map[string]interface{}{
			"x402Version": 1,
			"accepts":     []interface{}{},
		}

		paymentRequiredBytes, _ := json.Marshal(v1PaymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		assert.Nil(t, info)
	})

	t.Run("v1: should extract discovery info from POST with bodyFields", func(t *testing.T) {
		v1PaymentRequired := map[string]interface{}{
			"x402Version": 1,
			"accepts": []interface{}{
				map[string]interface{}{
					"scheme":            "exact",
					"network":           "eip155:8453",
					"maxAmountRequired": "1000000",
					"resource":          "https://api.example.com/search",
					"payTo":             "0x123",
					"asset":             "0x456",
					"maxTimeoutSeconds": 300,
					"outputSchema": map[string]interface{}{
						"input": map[string]interface{}{
							"type":         "http",
							"method":       "POST",
							"bodyType":     "json",
							"discoverable": true,
							"bodyFields": map[string]interface{}{
								"query": map[string]interface{}{
									"type":        "string",
									"description": "Search query",
								},
							},
						},
					},
				},
			},
		}

		paymentRequiredBytes, _ := json.Marshal(v1PaymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.NoError(t, err)
		require.NotNil(t, info)

		assert.Equal(t, "POST", info.Method)
		bodyInput, ok := info.DiscoveryInfo.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.BodyTypeJSON, bodyInput.BodyType)
	})

	t.Run("should return error for invalid json", func(t *testing.T) {
		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired([]byte("invalid"), true)
		require.Error(t, err)
		assert.Nil(t, info)
		assert.Contains(t, err.Error(), "failed to parse version")
	})

	t.Run("should return error for unsupported version", func(t *testing.T) {
		paymentRequired := map[string]interface{}{
			"x402Version": 99,
			"accepts":     []interface{}{},
		}
		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, true)
		require.Error(t, err)
		assert.Nil(t, info)
		assert.Contains(t, err.Error(), "unsupported version")
	})

	t.Run("v2: should skip validation when validate=false", func(t *testing.T) {
		// Create a simple extension (may not be fully valid)
		simpleExtension := map[string]interface{}{
			"info": map[string]interface{}{
				"input": map[string]interface{}{
					"type":   "http",
					"method": "GET",
				},
			},
			"schema": map[string]interface{}{},
		}

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
				"bazaar": simpleExtension,
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, false)
		require.NoError(t, err)
		require.NotNil(t, info)
		assert.Equal(t, "GET", info.Method)
	})

	t.Run("v2: should use routeTemplate as canonical URL for dynamic routes", func(t *testing.T) {
		// Mirrors the TestBazaarDynamicRoutes/should use routeTemplate for canonical URL test,
		// but exercises the ExtractDiscoveredResourceFromPaymentRequired code path so that
		// facilitators consuming payment-required responses also produce stable catalog keys.
		enrichedExt := map[string]interface{}{
			"info": map[string]interface{}{
				"input": map[string]interface{}{
					"type":   "http",
					"method": "GET",
				},
			},
			"schema":        map[string]interface{}{},
			"routeTemplate": "/products/:productId",
		}

		paymentRequired := x402.PaymentRequired{
			X402Version: 2,
			Resource: &x402.ResourceInfo{
				URL: "https://api.example.com/products/42",
			},
			Accepts: []x402.PaymentRequirements{
				{
					Scheme:  "exact",
					Network: "eip155:8453",
				},
			},
			Extensions: map[string]interface{}{
				bazaar.BAZAAR.Key(): enrichedExt,
			},
		}

		paymentRequiredBytes, _ := json.Marshal(paymentRequired)

		info, err := bazaar.ExtractDiscoveredResourceFromPaymentRequired(paymentRequiredBytes, false)
		require.NoError(t, err)
		require.NotNil(t, info)
		// The routeTemplate replaces the concrete URL path as the canonical catalog key
		assert.Equal(t, "https://api.example.com/products/:productId", info.ResourceURL)
		assert.Equal(t, "/products/:productId", info.RouteTemplate)
	})
}

// extractMethodEnum is a test helper that extracts the method enum from a discovery extension schema.
// It navigates: schema["properties"]["input"]["properties"]["method"]["enum"]
func extractMethodEnum(t *testing.T, schema bazaar.JSONSchema) []string {
	t.Helper()
	schemaProps := schema["properties"].(map[string]interface{})
	inputProps := schemaProps["input"].(map[string]interface{})
	inputPropsProps := inputProps["properties"].(map[string]interface{})
	methodProp := inputPropsProps["method"].(map[string]interface{})
	return methodProp["enum"].([]string)
}

// extractRequiredFields is a test helper that extracts the required array from a discovery extension schema.
// It navigates: schema["properties"]["input"]["required"]
func extractRequiredFields(t *testing.T, schema bazaar.JSONSchema) []string {
	t.Helper()
	schemaProps := schema["properties"].(map[string]interface{})
	inputProps := schemaProps["input"].(map[string]interface{})
	return inputProps["required"].([]string)
}

func TestBazaarResourceServerExtension(t *testing.T) {
	// NOTE: Go's API is different from TypeScript.
	// In Go, DeclareDiscoveryExtension takes the method as a parameter,
	// so the schema is already narrow at creation time.
	// In TypeScript, the method is inferred at runtime from the route key,
	// so declareDiscoveryExtension creates a broad enum and enrichDeclaration narrows it.

	t.Run("should enrich declaration with method from HTTP context", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"prompt": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"prompt": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)
		require.NoError(t, err)

		httpContext := x402http.HTTPRequestContext{
			Method: "POST",
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)

		// Method should be set in info.input
		bodyInput, ok := enrichedExt.Info.Input.(bazaar.BodyInput)
		require.True(t, ok)
		assert.Equal(t, bazaar.MethodPOST, bodyInput.Method)
	})

	t.Run("should create schema with narrow method enum for POST", func(t *testing.T) {
		// Go-specific: Unlike TypeScript, Go's DeclareDiscoveryExtension takes the method as a parameter.
		// This means the schema is already narrow at creation time.
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"data": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"data": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)
		require.NoError(t, err)

		// Schema should already have just ["POST"] at creation time
		methodEnum := extractMethodEnum(t, extension.Schema)
		assert.Equal(t, []string{"POST"}, methodEnum, "Go creates narrow enum at DeclareDiscoveryExtension time")

		// EnrichDeclaration should preserve the narrow enum
		httpContext := x402http.HTTPRequestContext{
			Method: "POST",
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)

		// After enrichment, the schema should still have just POST
		enrichedMethodEnum := extractMethodEnum(t, enrichedExt.Schema)
		assert.Equal(t, []string{"POST"}, enrichedMethodEnum, "Schema method enum should remain narrow after enrichment")
	})

	t.Run("should create schema with narrow method enum for GET", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "search term"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)
		require.NoError(t, err)

		// Schema should already have just ["GET"] at creation time
		methodEnum := extractMethodEnum(t, extension.Schema)
		assert.Equal(t, []string{"GET"}, methodEnum, "Go creates narrow enum at DeclareDiscoveryExtension time")

		httpContext := x402http.HTTPRequestContext{
			Method: "GET",
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)

		// After enrichment, should still be just GET
		enrichedMethodEnum := extractMethodEnum(t, enrichedExt.Schema)
		assert.Equal(t, []string{"GET"}, enrichedMethodEnum, "Schema method enum should remain narrow after enrichment")
	})

	t.Run("should add method to required array if not already present", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"prompt": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"prompt": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)
		require.NoError(t, err)

		httpContext := x402http.HTTPRequestContext{
			Method: "POST",
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)

		required := extractRequiredFields(t, enrichedExt.Schema)

		hasMethod := false
		for _, r := range required {
			if r == "method" {
				hasMethod = true
				break
			}
		}
		assert.True(t, hasMethod, "method should be in required array")
	})

	t.Run("should produce a valid extension after enrichment (GET)", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"query": map[string]interface{}{"type": "string"},
				},
			},
			"",
			nil,
		)
		require.NoError(t, err)

		httpContext := x402http.HTTPRequestContext{
			Method: "GET",
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)
		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)

		result := bazaar.ValidateDiscoveryExtension(enrichedExt)
		assert.True(t, result.Valid, "enriched GET extension should pass validation: %v", result.Errors)
	})

	t.Run("should produce a valid extension after enrichment (POST)", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"data": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"data": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)
		require.NoError(t, err)

		httpContext := x402http.HTTPRequestContext{
			Method: "POST",
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)
		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)

		result := bazaar.ValidateDiscoveryExtension(enrichedExt)
		assert.True(t, result.Valid, "enriched POST extension should pass validation: %v", result.Errors)
	})

	t.Run("should return unchanged declaration for non-HTTP context", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodPOST,
			map[string]interface{}{"data": "test"},
			bazaar.JSONSchema{
				"properties": map[string]interface{}{
					"data": map[string]interface{}{"type": "string"},
				},
			},
			bazaar.BodyTypeJSON,
			nil,
		)
		require.NoError(t, err)

		// Non-HTTP context
		nonHTTPContext := "not an http context"

		result := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, nonHTTPContext)

		// Should return unchanged
		resultExt, ok := result.(bazaar.DiscoveryExtension)
		require.True(t, ok)
		assert.Equal(t, extension.Info, resultExt.Info)
	})
}

func declareEmptyGETExtension(t *testing.T) bazaar.DiscoveryExtension {
	t.Helper()
	ext, err := bazaar.DeclareDiscoveryExtension(
		bazaar.MethodGET,
		map[string]interface{}{},
		bazaar.JSONSchema{"properties": map[string]interface{}{}},
		"",
		nil,
	)
	require.NoError(t, err)
	return ext
}

type mockHTTPAdapterForBazaar struct {
	headers map[string]string
	method  string
	path    string
	url     string
	accept  string
	agent   string
}

func (m *mockHTTPAdapterForBazaar) GetHeader(name string) string {
	if m.headers == nil {
		return ""
	}
	return m.headers[name]
}
func (m *mockHTTPAdapterForBazaar) GetMethod() string       { return m.method }
func (m *mockHTTPAdapterForBazaar) GetPath() string         { return m.path }
func (m *mockHTTPAdapterForBazaar) GetURL() string          { return m.url }
func (m *mockHTTPAdapterForBazaar) GetAcceptHeader() string { return m.accept }
func (m *mockHTTPAdapterForBazaar) GetUserAgent() string    { return m.agent }

func TestBazaarDynamicRoutes(t *testing.T) {
	t.Run("should leave static routes unchanged", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "test"},
			bazaar.JSONSchema{"properties": map[string]interface{}{"query": map[string]interface{}{"type": "string"}}},
			"",
			nil,
		)
		require.NoError(t, err)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/users",
			RoutePattern: "/users",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/users"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		// Static route: enriched should be DiscoveryExtension with empty RouteTemplate
		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok, "should always produce DiscoveryExtension")
		assert.Empty(t, enrichedExt.RouteTemplate, "static route should have empty RouteTemplate")
	})

	t.Run("should produce routeTemplate for dynamic routes", func(t *testing.T) {
		extension := declareEmptyGETExtension(t)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/users/123",
			RoutePattern: "/users/[userId]",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/users/123"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok, "dynamic route should produce a DiscoveryExtension")
		assert.Equal(t, "/users/:userId", enrichedExt.RouteTemplate)
	})

	t.Run("should extract path params from concrete URL", func(t *testing.T) {
		extension := declareEmptyGETExtension(t)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/users/123",
			RoutePattern: "/users/[userId]",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/users/123"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)

		queryInput, ok := enrichedExt.Info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		require.NotNil(t, queryInput.PathParams)
		assert.Equal(t, "123", queryInput.PathParams["userId"])
	})

	t.Run("should extract multiple path params", func(t *testing.T) {
		extension := declareEmptyGETExtension(t)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/users/42/posts/7",
			RoutePattern: "/users/[userId]/posts/[postId]",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/users/42/posts/7"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)
		assert.Equal(t, "/users/:userId/posts/:postId", enrichedExt.RouteTemplate)

		queryInput, ok := enrichedExt.Info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, "42", queryInput.PathParams["userId"])
		assert.Equal(t, "7", queryInput.PathParams["postId"])
	})

	t.Run("should produce routeTemplate for colon-style dynamic routes", func(t *testing.T) {
		extension := declareEmptyGETExtension(t)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/users/123",
			RoutePattern: "/users/:userId",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/users/123"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok, "colon-param dynamic route should produce a DiscoveryExtension")
		assert.Equal(t, "/users/:userId", enrichedExt.RouteTemplate)
	})

	t.Run("should extract path params from colon-style pattern", func(t *testing.T) {
		extension := declareEmptyGETExtension(t)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/users/42/posts/7",
			RoutePattern: "/users/:userId/posts/:postId",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/users/42/posts/7"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)
		assert.Equal(t, "/users/:userId/posts/:postId", enrichedExt.RouteTemplate)

		queryInput, ok := enrichedExt.Info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, "42", queryInput.PathParams["userId"])
		assert.Equal(t, "7", queryInput.PathParams["postId"])
	})

	t.Run("should handle mixed [param] and :param patterns", func(t *testing.T) {
		extension := declareEmptyGETExtension(t)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/users/42/posts/7",
			RoutePattern: "/users/[userId]/posts/:postId",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/users/42/posts/7"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)
		assert.Equal(t, "/users/:userId/posts/:postId", enrichedExt.RouteTemplate)

		queryInput, ok := enrichedExt.Info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, "42", queryInput.PathParams["userId"])
		assert.Equal(t, "7", queryInput.PathParams["postId"])
	})

	t.Run("should auto-convert wildcard * to :varN for discovery", func(t *testing.T) {
		extension := declareEmptyGETExtension(t)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/weather/san-francisco",
			RoutePattern: "/weather/*",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/weather/san-francisco"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)
		assert.Equal(t, "/weather/:var1", enrichedExt.RouteTemplate)

		queryInput, ok := enrichedExt.Info.Input.(bazaar.QueryInput)
		require.True(t, ok)
		assert.Equal(t, "san-francisco", queryInput.PathParams["var1"])
	})

	t.Run("should auto-convert multiple wildcards to :var1 :var2 etc", func(t *testing.T) {
		extension := declareEmptyGETExtension(t)

		httpContext := x402http.HTTPRequestContext{
			Method:       "GET",
			Path:         "/api/users/42/posts/7",
			RoutePattern: "/api/*/*/posts/*",
			Adapter:      &mockHTTPAdapterForBazaar{path: "/api/users/42/posts/7"},
		}

		enriched := bazaar.BazaarResourceServerExtension.EnrichDeclaration(extension, httpContext)

		enrichedExt, ok := enriched.(bazaar.DiscoveryExtension)
		require.True(t, ok)
		assert.Equal(t, "/api/:var1/:var2/posts/:var3", enrichedExt.RouteTemplate)
	})

	t.Run("should use concrete URL for static routes", func(t *testing.T) {
		extension, err := bazaar.DeclareDiscoveryExtension(
			bazaar.MethodGET,
			map[string]interface{}{"query": "test"},
			bazaar.JSONSchema{"properties": map[string]interface{}{"query": map[string]interface{}{"type": "string"}}},
			"",
			nil,
		)
		require.NoError(t, err)

		extensionJSON, err := json.Marshal(map[string]interface{}{
			"x402Version": 2,
			"scheme":      "exact",
			"network":     "eip155:8453",
			"payload":     map[string]interface{}{},
			"accepted":    map[string]interface{}{},
			"resource":    map[string]interface{}{"url": "http://example.com/search?q=test"},
			"extensions": map[string]interface{}{
				bazaar.BAZAAR.Key(): extension,
			},
		})
		require.NoError(t, err)

		var payload x402.PaymentPayload
		require.NoError(t, json.Unmarshal(extensionJSON, &payload))

		payloadJSON, err := json.Marshal(payload)
		require.NoError(t, err)

		discovered, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(payloadJSON, nil, false)
		require.NoError(t, err)
		require.NotNil(t, discovered)
		assert.Equal(t, "http://example.com/search", discovered.ResourceURL)
		assert.Empty(t, discovered.RouteTemplate)
	})
}

// TestDynamicRoutesCatalogConsolidation verifies that two requests to the same
// parameterized route produce the same canonical ResourceURL, so a catalog keyed by ResourceURL
// contains exactly one entry regardless of how many distinct concrete parameter values arrive.
func TestDynamicRoutesCatalogConsolidation(t *testing.T) {
	extension := declareEmptyGETExtension(t)

	makePayloadJSON := func(userID string) []byte {
		enrichedExt := map[string]interface{}{
			"info":          extension.Info,
			"schema":        extension.Schema,
			"routeTemplate": "/users/:userId",
		}
		b, err := json.Marshal(map[string]interface{}{
			"x402Version": 2,
			"scheme":      "exact",
			"network":     "eip155:8453",
			"payload":     map[string]interface{}{},
			"accepted":    map[string]interface{}{},
			"resource":    map[string]interface{}{"url": "http://api.example.com/users/" + userID},
			"extensions": map[string]interface{}{
				bazaar.BAZAAR.Key(): enrichedExt,
			},
		})
		require.NoError(t, err)
		return b
	}

	// First request: /users/123
	discovered1, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(makePayloadJSON("123"), nil, false)
	require.NoError(t, err)
	require.NotNil(t, discovered1)

	// Second request: /users/456 — different concrete ID, same route
	discovered2, err := bazaar.ExtractDiscoveredResourceFromPaymentPayload(makePayloadJSON("456"), nil, false)
	require.NoError(t, err)
	require.NotNil(t, discovered2)

	// Both must produce the same canonical URL so catalog sees a single entry
	assert.Equal(t, "http://api.example.com/users/:userId", discovered1.ResourceURL)
	assert.Equal(t, "http://api.example.com/users/:userId", discovered2.ResourceURL)
	assert.Equal(t, discovered1.ResourceURL, discovered2.ResourceURL,
		"requests to the same parameterized route should consolidate to one catalog entry")
}
