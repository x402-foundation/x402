package v1

import (
	"encoding/json"
	"strings"

	"github.com/x402-foundation/x402/go/extensions/types"
)

// V1OutputSchema represents the v1 outputSchema structure
type V1OutputSchema struct {
	Input  map[string]interface{} `json:"input"`
	Output interface{}            `json:"output,omitempty"`
}

// ExtractDiscoveryInfoV1 extracts discovery info from v1 PaymentRequirements and transforms to v2 format
//
// In v1, the discovery information is stored in the `outputSchema` field,
// which contains both input (endpoint shape) and output (response schema) information.
//
// This function makes smart assumptions to normalize v1 data into v2 DiscoveryInfo format:
// - For GET/HEAD/DELETE: Looks for queryParams, query, or params fields
// - For POST/PUT/PATCH: Looks for bodyFields, body, or data fields and normalizes bodyType
// - Extracts optional headers if present
//
// Args:
//   - paymentRequirements: V1 payment requirements (as a map or struct with outputSchema field)
//
// Returns:
//   - Discovery info in v2 format if present and valid, or nil if not discoverable
//
// Example:
//
//	requirements := map[string]interface{}{
//	    "outputSchema": map[string]interface{}{
//	        "input": map[string]interface{}{
//	            "type": "http",
//	            "method": "GET",
//	            "discoverable": true,
//	            "queryParams": map[string]interface{}{"query": "string"},
//	        },
//	        "output": map[string]interface{}{"type": "object"},
//	    },
//	}
//
//	info, err := v1.ExtractDiscoveryInfoV1(requirements)
//	if info != nil {
//	    fmt.Printf("Endpoint method: %v\n", info.Input)
//	}
func ExtractDiscoveryInfoV1(paymentRequirements interface{}) (*types.DiscoveryInfo, error) {
	// Convert to map for easier access
	var reqMap map[string]interface{}

	switch req := paymentRequirements.(type) {
	case map[string]interface{}:
		reqMap = req
	default:
		// Try to marshal and unmarshal
		data, err := json.Marshal(paymentRequirements)
		if err != nil {
			return nil, nil //nolint:nilerr // Intentional: no discovery info available
		}
		if err := json.Unmarshal(data, &reqMap); err != nil {
			return nil, nil //nolint:nilerr // Intentional: no discovery info available
		}
	}

	// Get outputSchema
	outputSchemaRaw, ok := reqMap["outputSchema"]
	if !ok {
		return nil, nil
	}

	outputSchemaMap, ok := outputSchemaRaw.(map[string]interface{})
	if !ok {
		return nil, nil
	}

	// Check if it has the expected structure
	v1InputRaw, ok := outputSchemaMap["input"]
	if !ok {
		return nil, nil
	}

	v1Input, ok := v1InputRaw.(map[string]interface{})
	if !ok {
		return nil, nil
	}

	// Check type is "http"
	inputType, ok := v1Input["type"].(string)
	if !ok || inputType != "http" {
		return nil, nil
	}

	// Check method exists
	methodRaw, ok := v1Input["method"]
	if !ok {
		return nil, nil
	}

	method, ok := methodRaw.(string)
	if !ok {
		return nil, nil
	}

	// Check if discoverable (default to true if not specified)
	discoverable := true
	if discoverableRaw, ok := v1Input["discoverable"]; ok {
		if discoverableBool, ok := discoverableRaw.(bool); ok {
			discoverable = discoverableBool
		}
	}

	if !discoverable {
		return nil, nil
	}

	method = strings.ToUpper(method)

	// Extract headers if present
	var headers map[string]string
	if headerFieldsRaw, ok := v1Input["headerFields"]; ok {
		if headerFieldsMap, ok := headerFieldsRaw.(map[string]interface{}); ok {
			headers = make(map[string]string)
			for k := range headerFieldsMap {
				headers[k] = "" // V1 has complex header schema, we just extract keys
			}
		}
	} else if headerFieldsRaw, ok := v1Input["header_fields"]; ok {
		if headerFieldsMap, ok := headerFieldsRaw.(map[string]interface{}); ok {
			headers = make(map[string]string)
			for k := range headerFieldsMap {
				headers[k] = ""
			}
		}
	} else if headersRaw, ok := v1Input["headers"]; ok {
		if headersMap, ok := headersRaw.(map[string]interface{}); ok {
			headers = make(map[string]string)
			for k, v := range headersMap {
				if vStr, ok := v.(string); ok {
					headers[k] = vStr
				}
			}
		}
	}

	// Extract output example/schema if present
	var output *types.OutputInfo
	if outputRaw, ok := outputSchemaMap["output"]; ok && outputRaw != nil {
		output = &types.OutputInfo{
			Type:    "json",
			Example: outputRaw,
		}
	}

	// Transform based on method type
	if types.IsQueryMethod(method) {
		// Query parameter method (GET, HEAD, DELETE)
		queryParams := extractQueryParams(v1Input)

		queryInput := types.QueryInput{
			Type:        "http",
			Method:      types.QueryParamMethods(method),
			QueryParams: queryParams,
			Headers:     headers,
		}

		return &types.DiscoveryInfo{
			Input:  queryInput,
			Output: output,
		}, nil
	} else if types.IsBodyMethod(method) {
		// Body method (POST, PUT, PATCH)
		body, bodyType := extractBodyInfo(v1Input)
		queryParams := extractQueryParams(v1Input) // Some POST requests also have query params

		bodyInput := types.BodyInput{
			Type:        "http",
			Method:      types.BodyMethods(method),
			BodyType:    bodyType,
			Body:        body,
			QueryParams: queryParams,
			Headers:     headers,
		}

		return &types.DiscoveryInfo{
			Input:  bodyInput,
			Output: output,
		}, nil
	}

	// Unsupported method
	return nil, nil
}

// extractQueryParams extracts query parameters from v1 input
func extractQueryParams(v1Input map[string]interface{}) map[string]interface{} {
	// Check various common field names used in v1 (both camelCase and snake_case)
	if queryParams, ok := v1Input["queryParams"].(map[string]interface{}); ok {
		return queryParams
	}
	if queryParams, ok := v1Input["query_params"].(map[string]interface{}); ok {
		return queryParams
	}
	if query, ok := v1Input["query"].(map[string]interface{}); ok {
		return query
	}
	if params, ok := v1Input["params"].(map[string]interface{}); ok {
		return params
	}
	return nil
}

// extractBodyInfo extracts body information from v1 input
func extractBodyInfo(v1Input map[string]interface{}) (interface{}, types.BodyType) {
	// Determine body type (check both camelCase and snake_case)
	bodyType := types.BodyTypeJSON

	if bodyTypeField, ok := v1Input["bodyType"].(string); ok {
		bodyType = normalizeBodyType(bodyTypeField)
	} else if bodyTypeField, ok := v1Input["body_type"].(string); ok {
		bodyType = normalizeBodyType(bodyTypeField)
	}

	// Extract body content from various possible fields
	var body interface{} = map[string]interface{}{}

	if bodyFields, ok := v1Input["bodyFields"]; ok {
		body = bodyFields
	} else if bodyFields, ok := v1Input["body_fields"]; ok && bodyFields != nil {
		body = bodyFields
	} else if bodyParams, ok := v1Input["bodyParams"]; ok {
		body = bodyParams
	} else if bodyRaw, ok := v1Input["body"]; ok {
		body = bodyRaw
	} else if data, ok := v1Input["data"]; ok {
		body = data
	} else if properties, ok := v1Input["properties"]; ok {
		// Some endpoints have properties directly at the input level
		body = properties
	}

	return body, bodyType
}

// normalizeBodyType normalizes body type string to BodyType
func normalizeBodyType(typeStr string) types.BodyType {
	typeStr = strings.ToLower(typeStr)
	if strings.Contains(typeStr, "form") || strings.Contains(typeStr, "multipart") {
		return types.BodyTypeFormData
	} else if strings.Contains(typeStr, "text") || strings.Contains(typeStr, "plain") {
		return types.BodyTypeText
	}
	return types.BodyTypeJSON
}

// IsDiscoverableV1 checks if v1 PaymentRequirements contains discoverable information
//
// Args:
//   - paymentRequirements: V1 payment requirements
//
// Returns:
//   - True if the requirements contain valid discovery info
//
// Example:
//
//	if v1.IsDiscoverableV1(requirements) {
//	    info, _ := v1.ExtractDiscoveryInfoV1(requirements)
//	    // Catalog info in Bazaar
//	}
func IsDiscoverableV1(paymentRequirements interface{}) bool {
	info, _ := ExtractDiscoveryInfoV1(paymentRequirements)
	return info != nil
}

// ExtractResourceMetadataV1 extracts resource metadata from v1 PaymentRequirements
//
// In v1, resource information is embedded directly in the payment requirements
// rather than in a separate resource object.
//
// Args:
//   - paymentRequirements: V1 payment requirements
//
// Returns:
//   - Resource metadata (url, description, mimeType)
//
// Example:
//
//	metadata := v1.ExtractResourceMetadataV1(requirements)
//	fmt.Printf("Resource URL: %s\n", metadata["url"])
func ExtractResourceMetadataV1(paymentRequirements interface{}) map[string]string {
	// Convert to map
	var reqMap map[string]interface{}

	switch req := paymentRequirements.(type) {
	case map[string]interface{}:
		reqMap = req
	default:
		data, err := json.Marshal(paymentRequirements)
		if err != nil {
			return map[string]string{}
		}
		if err := json.Unmarshal(data, &reqMap); err != nil {
			return map[string]string{}
		}
	}

	result := make(map[string]string)

	if resource, ok := reqMap["resource"].(string); ok {
		result["url"] = resource
	}

	if description, ok := reqMap["description"].(string); ok {
		result["description"] = description
	}

	if mimeType, ok := reqMap["mimeType"].(string); ok {
		result["mimeType"] = mimeType
	}

	return result
}
